// Fresh-launch sniper for the Pump.fun Paper Sprint (agent-fun/replay/v2).
//
// Idea: a pump.fun coin's tradable life is front-loaded. Most coins die flat,
// a few run hard in their first minute, and nothing on the tape reliably tells
// them apart in advance — so the bot buys a filtered slice of hot launches,
// takes a quick partial profit when one runs, and cuts every loser fast.
// Every comparison is exact bigint arithmetic; there is no clock, no
// environment read and no randomness, so the two grading runs agree byte for
// byte.
//
// Entry (decided once per coin, on the batch its 8th trade arrives):
//   * age at most MAX_AGE_SLOTS after creation
//   * real SOL in the curve between MIN_REAL_SOL and MAX_REAL_SOL
//   * price at least MIN_RUNUP_BPS of its creation price
//   * at least MIN_TRADES trades, from at most MAX_BUYERS distinct
//     non-creator buyers (real demand, not one wallet wash-trading)
//   * the creator's own buy in the creation slot at most MAX_DEV_BUY_SOL
//     (a heavy dev buy is a rug tell)
//   * one buy per coin, STAKE_SOL capped at 1% of the curve's real SOL
//     (the harness size cap) and at least MIN_BUY_SOL
//
// Exit (checked every batch for every open position):
//   * the creator sells -> sell everything immediately
//   * value falls to STOP_LOSS_BPS of cost -> sell everything
//   * value reaches TP1_BPS of cost -> sell half, let the rest run
//   * value falls TRAIL_DROP_BPS below its best value -> sell everything
//   * FIRST_HOLD_SLOTS after the buy decision -> sell everything
//
// The guardrail needs a >= 0.01 SOL round trip on >= 20 coins with max
// drawdown <= 50%; MIN_BUY_SOL is set to the round-trip floor so every
// filled buy counts.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const STAKE_SOL = 20n; // 0.20 SOL per buy (x100 scale: value * 10n^7 lamports)
const MIN_BUY_SOL = 1n; // 0.01 SOL: the guardrail's round-trip floor
const MAX_AGE_SLOTS = 30;
const MIN_TRADES = 8;
const MAX_BUYERS = 6;
const MIN_REAL_SOL = 4n;
const MAX_REAL_SOL = 30n;
const MIN_RUNUP_BPS = 12_500; // price >= 1.25x creation price
const MAX_DEV_BUY_SOL = 150n; // 1.50 SOL (x100 scale)
const TP1_BPS = 12_500; // +25%: sell half
const STOP_LOSS_BPS = 8_800; // -12%: sell all
const TRAIL_DROP_BPS = 1_000; // -10% from best value: sell all
const FIRST_HOLD_SLOTS = 120;
const BUY_SLIPPAGE_BPS = 1_000;
const SELL_SLIPPAGE_BPS = 10_000;

const SOL = LAMPORTS_PER_SOL;
const CENTI_SOL = SOL / 100n; // 0.01 SOL
const STAKE_LAMPORTS = STAKE_SOL * CENTI_SOL;
const MIN_BUY_LAMPORTS = MIN_BUY_SOL * CENTI_SOL;
const MIN_REAL_LAMPORTS = MIN_REAL_SOL * SOL;
const MAX_REAL_LAMPORTS = MAX_REAL_SOL * SOL;
const MAX_DEV_BUY_LAMPORTS = MAX_DEV_BUY_SOL * CENTI_SOL;

// ------------------------------------------------------------------ tracking

/** What the bot has seen of one fresh coin while it is still a candidate. */
interface Watch {
  creator: string;
  createdSlot: number;
  /** Creation price as a fraction (virtual SOL / virtual tokens). */
  createVq: bigint;
  createVt: bigint;
  trades: number;
  buyers: Set<string>;
  /** SOL the creator bought in the creation slot. */
  devBuyLamports: bigint;
}

/** Bookkeeping for one open position. */
interface OpenTrade {
  creator: string;
  /** Slot the buy was decided on (fills land 2 slots later). */
  entrySlot: number;
  /** Best value/cost ratio seen, in bps (10000 = breakeven). */
  bestRatioBps: bigint;
  tp1Done: boolean;
}

const watches = new Map<string, Watch>();
/** Mints whose entry decision is made (bought, or rejected for good). */
const decided = new Set<string>();
const openTrades = new Map<string, OpenTrade>();

/** Value of `tokens` at the curve's current reserves, in lamports. */
function valueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt <= 0n || tokens <= 0n) return 0n;
  return (tokens * vq) / vt;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    let freeCash = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // --- 1. Fold this batch's events into the watches, and spot creator sells.
    const creatorSold = new Set<string>();
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!decided.has(e.mint) && !watches.has(e.mint)) {
          watches.set(e.mint, {
            creator: e.creator,
            createdSlot: e.slot,
            createVq: BigInt(e.virtual_quote_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            trades: 0,
            buyers: new Set<string>(),
            devBuyLamports: 0n,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const w = watches.get(e.mint);
        if (w !== undefined) {
          w.trades += 1;
          if (e.is_buy) {
            if (e.user === w.creator) {
              if (e.slot === w.createdSlot) w.devBuyLamports += BigInt(e.sol_amount);
            } else {
              w.buyers.add(e.user);
            }
          }
          touched.add(e.mint);
        }
        const t = openTrades.get(e.mint);
        if (t !== undefined && !e.is_buy && e.user === t.creator) creatorSold.add(e.mint);
      } else {
        // CompleteEvent: the curve is done; drop the watch. The harness
        // closes any position in it on its own.
        watches.delete(e.mint);
      }
    }

    // --- 2. Entries: decide each touched coin once, on its 8th trade.
    for (const mint of touched) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const w = watches.get(mint);
      if (w === undefined || decided.has(mint)) continue;
      if (w.trades < MIN_TRADES) continue;
      const age = batch.slot - w.createdSlot;
      if (age > MAX_AGE_SLOTS) {
        // Too old to ever qualify again; stop watching it.
        watches.delete(mint);
        decided.add(mint);
        continue;
      }
      decided.add(mint);
      watches.delete(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_LAMPORTS) continue;
      if (curve.real_quote_reserves > MAX_REAL_LAMPORTS) continue;
      if (w.buyers.size > MAX_BUYERS) continue;
      if (w.devBuyLamports > MAX_DEV_BUY_LAMPORTS) continue;
      // Runup: current price >= 1.25x creation price, cross-multiplied so
      // no division ever loses precision:
      //   vq/vt >= 1.25 * createVq/createVt
      if (w.createVt <= 0n || curve.virtual_token_reserves <= 0n) continue;
      const lhs = curve.virtual_quote_reserves * w.createVt * 10_000n;
      const rhs = w.createVq * curve.virtual_token_reserves * BigInt(MIN_RUNUP_BPS);
      if (lhs < rhs) continue;
      if (openSlots <= 0) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (freeCash < amount + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      } satisfies BuyInput);
      freeCash -= amount + txFee;
      openSlots -= 1;
      openTrades.set(mint, {
        creator: w.creator,
        entrySlot: batch.slot,
        bestRatioBps: 0n,
        tp1Done: false,
      });
    }

    // --- 3. Exits: walk the open positions and enforce the exit rules.
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = openTrades.get(mint);
      if (t === undefined) continue; // not ours (cannot happen, but be safe)
      const cost = pos.cost_lamports;
      if (cost <= 0n) continue;
      const value = valueLamports(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const ratioBps = (value * 10_000n) / cost;
      if (ratioBps > t.bestRatioBps) t.bestRatioBps = ratioBps;

      let sellAll = false;
      let sellHalf = false;
      if (creatorSold.has(mint)) {
        sellAll = true; // the creator is exiting: get out now
      } else if (ratioBps <= BigInt(STOP_LOSS_BPS)) {
        sellAll = true;
      } else if (!t.tp1Done && ratioBps >= BigInt(TP1_BPS)) {
        sellHalf = true;
      } else if (t.bestRatioBps > 0n && ratioBps * 10_000n <= t.bestRatioBps * BigInt(10_000 - TRAIL_DROP_BPS)) {
        sellAll = true; // gave back 10% from its best value: bank it
      } else if (batch.slot - t.entrySlot >= FIRST_HOLD_SLOTS) {
        sellAll = true;
      }
      if (sellHalf) {
        const half = pos.token_amount / 2n;
        if (half <= 0n) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: half,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        } satisfies SellInput);
        t.tp1Done = true;
      } else if (sellAll) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        } satisfies SellInput);
      }
    }

    // --- 4. Drop bookkeeping for positions that are gone (sold, completed,
    // or flattened) and have nothing still in flight. A buy sent on this
    // batch is not in state.pending yet (the shim records orders only after
    // onBatch returns), so never drop a trade younger than a few slots:
    // its fill lands 2 slots after the decision and is reported in the
    // first batch after that. Without the age guard the trade would be
    // deleted in the very batch its buy was sent and the position would
    // never be exited.
    for (const [mint, t] of [...openTrades.entries()]) {
      if (state.positions.has(mint)) continue;
      if (batch.slot - t.entrySlot <= 10) continue;
      let inFlight = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint) {
          inFlight = true;
          break;
        }
      }
      if (!inFlight) openTrades.delete(mint);
    }

    return orders;
  },
});
