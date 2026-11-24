# Pump.fun Replay Sprint — Paper Bot

A paper-trading bot for make.fun's [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity, ranked by net PnL.

![make.fun bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/nganunganu275/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/nganunganu275/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)

## Strategy

Young-momentum sniper with a runner rule, built by an AI agent for the make.fun bounty above.

- **Entry:** young coins (10–100 slots old) whose last 20 slots show real buying — net inflow ≥ 0.3 SOL, ≥ 3 buys, ≥ 3 distinct buyers, price up ≥ 5% — with 1–30 SOL real reserve. Small 0.02 SOL stakes.
- **Rug filter:** never buys a coin whose creator has sold; exits at once if the creator sells while holding.
- **Exits:** 15% stop-loss, 40% trailing stop (arms at +30%), 200-slot max hold — except the **runner rule**: a position up ≥ 50% at its max hold keeps riding under the trailing stop, so a coin running to migration (85 SOL real reserve) can pay x5–x10.
- **Guardrail fallback:** tiny 0.01 SOL probe round trips if fewer than 20 coins are traded after 12h of window time (not needed on a normal 24h window — the bot trades 300+ coins).

## Dev result

On the kit's dev window (24h, 2–3 Nov 2026, 1,222 coins): net PnL −0.50 SOL over 331 coins (53 wins, max drawdown 5.7%), with two completer catches (CHjgAu +0.168 SOL, 6MVWPQ +0.083 SOL on 0.02 SOL stakes). The dev window is negative-sum for every active strategy tested; this shape loses the least while keeping the completer ticket. Deterministic: two runs produce byte-identical action logs.

## Layout

- `main.ts` — the bot (Node 22, ESM, no dependencies; run as `node main.ts`)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, byte-identical copy
- `LICENSE` — MIT
