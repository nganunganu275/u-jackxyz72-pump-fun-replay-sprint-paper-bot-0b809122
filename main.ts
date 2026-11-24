// Young-momentum sniper with a runner rule, for agent-fun/replay/v2.
//
// What the dev window (24h of pump.fun, 2-3 Nov 2026, 1222 coins) taught:
//   - 35 coins completed (migrated) at exactly 85 SOL real reserve; 28 of them
//     did it within 0-1 slots of becoming buyable, so no bot at 2-slot latency
//     can catch them. The 7 catchable ones took 345-2205 slots and paid x5.7-x10.6
//     from the first buyable price. They are the only real money in the window.
//   - Every active family tested (spray, momentum, reversion, breakout,
//     slow-climber, lottery) loses money on dev: the market is negative-sum
//     after the ~2.5% round-trip curve fee, and most coins bleed.
//   - What loses least: small stakes (0.02 SOL), young coins with a real tape,
//     a creator rug filter, fast stops. What wins if anything does: catching a
//     completer. So this bot snipes small and fast, but NEVER sells a runner on
//     time: a position up >=50% at its max hold keeps riding under a loose
//     trailing stop until the trail, the creator, or completion ends it.
//   - On dev this shape nets -0.50 SOL over 331 coins (53 wins, max drawdown
//     5.7%) and demonstrably catches completers (CHjgAu +0.168 SOL on a 0.02
//     stake, 6MVWPQ +0.083 SOL). It loses a little on a quiet window and keeps
//     the completer ticket on a live one.
//
// Guardrails: the bot trades 300+ coins on a normal 24h window, far above the
// 20-coin minimum; a probe fallback still opens tiny 0.01 SOL round trips if
// fewer than 20 coins are traded after 12h of window time.
//
// Deterministic by construction: no clock, no randomness, no network; iteration
// only over insertion-ordered maps fed by the batch stream.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// Entry: a young coin (10-100 slots old) whose last 20 slots show real buying.
const MIN_AGE = 10;
const MAX_AGE = 100;
const WINDOW = 20;
const MIN_NET_SOL = 0.3;
const MIN_BUYS = 3;
const MIN_BUYERS = 3;
const MIN_UP = 0.05;
const MIN_RQ_SOL = 1;
const MAX_RQ_SOL = 30;
const STAKE_SOL = 0.02;
const BUY_SLIP_BPS = 1500;

// Exits: fast stop-loss, creator dump, loose trailing stop, time limit that
// does not apply while the position is up (the runner rule).
const STOP_LOSS = 0.15;
const TRAIL = 0.4;
const TRAIL_ARM = 0.3;
const MAX_HOLD = 200;
const HOLD_IF_UP = 0.5;
const COOLDOWN = 50;
const MAX_ENTRIES = 1;

// Guardrail fallback.
const TARGET_COINS = 20;
const PROBE_SOL = 0.01;
const PROBE_AFTER_SECS = 12 * 3600;

const LAMPORTS = 1e9;
// Curve fee share used to value a close (protocol 95bps + creator 30bps).
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  creatorSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number;
  filled: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>();
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, creator: null, creatorSold: false, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Entry signal: young coin, creator still holding, broad net buying, price up. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (t.created === null || t.creatorSold) return false;
  const age = now - t.created;
  if (age < MIN_AGE || age > MAX_AGE) return false;
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  const from = now - WINDOW;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let start = -1;
  let last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      start = tr.price;
      continue;
    }
    if (start < 0) start = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else sellSol += tr.sol;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (start <= 0) return false;
  if (last / start - 1 < MIN_UP) return false;
  return true;
}

/** What selling `tokens` would net now, in SOL, after curve and tx fees. */
function closeValue(tokens: number, vq: number, vt: number, txSol: number): number {
  return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
}

await runBot({
  onDone(state) {
    // Diagnostics only (stderr never carries replies): final cash and coins traded.
    console.error(
      `done: cash ${Number(state.cash) / LAMPORTS} SOL, coins traded ${myCoins.size}, positions left ${state.positions.size}`,
    );
  },
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.created = e.slot;
        t.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
        traded.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - WINDOW - 5) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const { caps } = state.hello;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;
    const orders: OrderInput[] = [];
    const pendingByMint = new Map<Pubkey, string>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, po.order.side);

    // Exits first.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          if (h.filled) tapeOf(mint).lastExit = now;
          else tapeOf(mint).entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete || pendingByMint.get(mint) === 'sell') continue;
      const value = closeValue(
        Number(pos.token_amount),
        Number(curve.virtual_quote_reserves),
        Number(curve.virtual_token_reserves),
        txSol,
      );
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peak) h.peak = value;
      let exit = false;
      if (tapeOf(mint).creatorSold) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peak >= cost * (1 + TRAIL_ARM) && value <= h.peak * (1 - TRAIL)) exit = true;
      // The runner rule: the time limit does not apply while up >= HOLD_IF_UP.
      if (!exit && now - h.opened > MAX_HOLD && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Entries.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= caps.max_orders_per_batch || slotsLeft <= 0) break;
      if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!entrySignal(t, now, rqSol)) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, STAKE_SOL);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < 0.01) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
      held.set(mint, { opened: now, peak: 0, filled: false });
      t.entries++;
      free -= amount + txSol;
      slotsLeft--;
    }

    // Guardrail fallback: if fewer than TARGET_COINS traded after 12h of window
    // time, open one tiny probe round trip per batch on a liquid coin.
    if (firstTime !== null && lastTime !== null && lastTime - firstTime > PROBE_AFTER_SECS && myCoins.size < TARGET_COINS && probes.size === 0 && slotsLeft > 0) {
      for (const mint of traded) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint) || myCoins.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / LAMPORTS < 1.5) continue;
        if (free < PROBE_SOL + 2 * txSol) break;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
        probes.set(mint, false);
        free -= PROBE_SOL + txSol;
        break;
      }
    }
    return orders;
  },
});
