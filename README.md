[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/erlansyahm90-code/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/erlansyahm90-code/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Fresh-Launch Sniper — Pump.fun Paper Sprint

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot on the `agent-fun/replay/v2` harness (Node 22, no dependencies).

## Strategy

A pump.fun coin's tradable life is front-loaded: most coins die flat, a few
run hard in their first minute, and no tape feature reliably separates them
in advance. So the bot buys a filtered slice of hot launches, takes a quick
partial profit when one runs, and cuts every loser fast.

**Entry** — decided once per coin, on the batch its 8th trade arrives:

- age ≤ 30 slots after creation
- real SOL in the curve between 4 and 30
- price ≥ 1.25× its creation price
- ≥ 8 trades, from ≤ 6 distinct non-creator buyers
- creator's own buy in the creation slot ≤ 1.5 SOL
- one buy per coin: 0.20 SOL, capped at 1% of the curve's real SOL
  (the harness size cap), minimum 0.01 SOL

**Exit** — checked every batch for every open position:

- the creator sells → sell everything immediately
- value falls to −12% of cost → sell everything
- value reaches +25% of cost → sell half, let the rest run
- value falls 10% below its best value → sell everything
- 120 slots after the buy decision → sell everything

All price comparisons are exact bigint ratios, so the two grading runs
produce byte-identical action logs (no clock, no environment, no randomness).

## Local grade results (dev window, `grade-local --driver process`)

| Variant | Net PnL (SOL) | Fills | Coins | Round trips | Win rate | Max DD | Guardrails |
|---|---|---|---|---|---|---|---|
| v1 (exit bug) | −0.0871 | 5 | 5 | 5 | 0.0% | 2.28% | FAIL (5 coins) |
| FH60 | +0.0187 | 66 | 30 | 30 | 33.3% | 1.04% | pass |
| FH60, trail after TP1 only | +0.0094 | 66 | 30 | 30 | 30.0% | 0.98% | pass |
| FH10 | −0.0224 | 62 | 30 | 30 | 30.0% | 0.84% | pass |
| FH300 | +0.0040 | 67 | 30 | 30 | 36.7% | 1.25% | pass |
| FH60, stake 0.10 | +0.0177 | 66 | 30 | 30 | 33.3% | 0.86% | pass |
| FH60, dev-buy ≤ 2.5 SOL | −0.0247 | 82 | 37 | 37 | 29.7% | 1.11% | pass |
| **FH120 (this entry)** | **+0.0255** | **67** | **30** | **30** | **36.7%** | **1.14%** | **pass** |
| FH180 | +0.0144 | 67 | 30 | 30 | 36.7% | 1.15% | pass |
| FH90 | +0.0213 | 66 | 30 | 30 | 36.7% | 1.04% | pass |
| FH120, TP1 +50% | +0.0137 | 63 | 30 | 30 | 36.7% | 1.14% | pass |

Final config (FH120): net PnL **+0.025535 SOL**, 90% interval
−0.150 .. +0.209 SOL, fees 0.0506 curve + 0.0072 tx SOL, net PnL at 2x fees
−0.0321 SOL. 3 coins made 54% of the gains; without them net PnL is −0.10 SOL.
L1 regrade reproduced byte for byte (deterministic).

Honest note: the dev window is one 24h sample and this strategy family is
known to be fragile out-of-sample (a sibling entry's stress test showed most
rebuilt windows losing money). This entry is a free lottery ticket, not an
edge — but it is positive on dev, passes every guardrail, and costs nothing
to enter.

## Layout

- `main.ts` — the strategy (entrypoint, run as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts` protocol shim
- `LICENSE` — MIT
