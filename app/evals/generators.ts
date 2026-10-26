// Parametric, seeded fixture generators for the eval suite.
//
//   baseline(seed)            a "neutral trader": a small positive edge, no habit
//   plantX(fixture, {...})    layer one habit on top of (or within) the baseline,
//                             returns the ids of the planted trades
//   toClosedCsv / toFillsCsv  write the fixture as a closed-trades file or as
//                             Zerodha-style executions (which exercises the
//                             engine's round-trip reconstruction)
//
// Nothing here imports the analysis engine.

import {
  BANKNIFTY,
  HDFCBANK,
  INFY,
  NIFTY,
  RELIANCE,
  TCS,
  Rng,
  fillsToCsv,
  hashSeed,
  isTuesday,
  legsToRows,
  makeLegs,
  niftySymbol,
  placeItems,
  roundTick,
  stamp,
  symbolFor,
  weekdaysFrom,
  type FillRow,
  type Instrument,
  type PlaceItem,
} from './common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FxTrade {
  id: string;
  inst: Instrument;
  symbol: string;
  date: string;
  entryMin: number; // minute of day
  hold: number; // minutes
  dir: 1 | -1; // 1 = bought first
  qty: number;
  /** gross P&L in rupees */
  pnl: number;
  /** reported charges (used by the closed-trades writer; the fills writer leaves charges to the engine) */
  fees: number;
  tags: string[];
}

export interface Fixture {
  name: string;
  seed: number;
  rng: Rng;
  days: string[];
  trades: FxTrade[];
  nextId: number;
  /** planted trade ids by habit key */
  planted: Record<string, string[]>;
}

export type HabitKind =
  | 'instrument-bleed'
  | 'loss-streak'
  | 'quick-reentry'
  | 'overtrading'
  | 'time-window'
  | 'expiry-day'
  | 'holding-losers'
  | 'size-after-loss'
  | 'fee-churn';

export const HABIT_KINDS: HabitKind[] = [
  'instrument-bleed',
  'loss-streak',
  'quick-reentry',
  'overtrading',
  'time-window',
  'expiry-day',
  'holding-losers',
  'size-after-loss',
  'fee-churn',
];

export const DEFAULT_BLEED_VARIANT = 'HDFCBANK';
export const DEFAULT_WINDOW_VARIANT = 'midday';

/** The key the engine should report for a planted habit. */
export function expectedKey(kind: HabitKind, variant?: string): string {
  if (kind === 'instrument-bleed') return `instrument-bleed:${variant ?? DEFAULT_BLEED_VARIANT}`;
  if (kind === 'time-window') return `time-window:${variant ?? DEFAULT_WINDOW_VARIANT}`;
  return kind;
}

// ---------------------------------------------------------------------------
// Instruments (same size every time, so nothing looks like sizing up)
// ---------------------------------------------------------------------------

interface FxInst {
  inst: Instrument;
  /** multiplier on the base P&L distribution */
  scale: number;
  /** smallest |gross P&L|: keeps charges below 30% of the move */
  minAbs: number;
  /** typical round-trip charges, used for the reported fees column */
  fee: number;
}

const FX: Record<string, FxInst> = {
  NIFTY: { inst: { ...NIFTY, qty: 130, price: 120 }, scale: 1, minAbs: 350, fee: 48 },
  BANKNIFTY: { inst: { ...BANKNIFTY, qty: 60, price: 280 }, scale: 1, minAbs: 320, fee: 55 },
  HDFCBANK: { inst: { ...HDFCBANK, qty: 100, price: 1000 }, scale: 1, minAbs: 320, fee: 82 },
  INFY: { inst: { ...INFY, qty: 100, price: 1500 }, scale: 1.15, minAbs: 400, fee: 100 },
  TCS: { inst: { ...TCS, qty: 50, price: 3300 }, scale: 1.2, minAbs: 420, fee: 105 },
  RELIANCE: { inst: { ...RELIANCE, qty: 500, price: 1400 }, scale: 3.4, minAbs: 1700, fee: 441 },
};

const CORE = ['NIFTY', 'BANKNIFTY', 'HDFCBANK', 'INFY'];
const EXTRA = ['RELIANCE', 'TCS'];

const WIN_MEAN = 650;
const WIN_SD = 170;
const LOSS_MEAN = 480;
const LOSS_SD = 130;
const P_WIN = 0.57; // small positive edge: 0.57*650 - 0.43*480 = +164 per trade

export const instOf = (name: string): FxInst => {
  const f = FX[name];
  if (!f) throw new Error(`unknown underlying ${name}`);
  return f;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const net = (t: FxTrade) => t.pnl - t.fees;
const exitMin = (t: FxTrade) => t.entryMin + t.hold;

export const WINDOWS = {
  opening: [555, 585],
  morning: [585, 690],
  midday: [690, 810],
  afternoon: [810, 885],
  closing: [885, 960],
} as const;
export type WindowName = keyof typeof WINDOWS;

export function windowOf(entryMin: number): WindowName {
  for (const [name, [a, z]] of Object.entries(WINDOWS)) if (entryMin >= a && entryMin < z) return name as WindowName;
  return 'closing';
}

function newId(fx: Fixture): string {
  return `T${String(fx.nextId++).padStart(3, '0')}`;
}

/**
 * Draw a P&L for an outcome using the underlying's scale. `lossMult` only
 * stretches losers (habits make losses bigger, not wins); `sizeRatio` scales
 * both (a bigger position moves more rupees).
 */
function drawPnl(rng: Rng, name: string, win: boolean, lossMult = 1, sizeRatio = 1): number {
  const f = instOf(name);
  const raw = win ? rng.normal(WIN_MEAN, WIN_SD) : rng.normal(LOSS_MEAN, LOSS_SD);
  const mag = Math.max(f.minAbs, raw * f.scale) * (win ? 1 : lossMult) * sizeRatio;
  return Math.round((win ? mag : -mag) * 100) / 100;
}

/** Exactly round(n * p) wins among n trades, in random order (a planted effect should not depend on luck). */
function winFlags(rng: Rng, n: number, p: number): boolean[] {
  const k = Math.round(n * clamp01(p));
  return rng.shuffle(Array.from({ length: n }, (_, i) => i < k));
}

function drawFee(rng: Rng, name: string): number {
  return Math.round(instOf(name).fee * rng.float(0.85, 1.15) * 100) / 100;
}

function setOutcome(fx: Fixture, t: FxTrade, win: boolean, lossMult = 1): void {
  t.pnl = drawPnl(fx.rng, t.inst.underlying, win, lossMult, t.qty / t.inst.qty);
}

const toItem = (t: FxTrade): PlaceItem => ({ key: t.inst.underlying, hold: t.hold, loss: net(t) < 0 });

/** Entry times are always re-drawn through placeItems so same-underlying trades never collide. */
function replaceDay(fx: Fixture, date: string, tweak?: (t: FxTrade, item: PlaceItem) => void, tries = 60): boolean {
  const ts = fx.trades.filter((t) => t.date === date);
  for (let k = 0; k < tries; k++) {
    const items = ts.map((t) => {
      const item = toItem(t);
      tweak?.(t, item);
      return item;
    });
    const entries = placeItems(items, fx.rng);
    if (entries) {
      ts.forEach((t, i) => (t.entryMin = entries[i]));
      return true;
    }
  }
  return false;
}

const tradesOn = (fx: Fixture, date: string) =>
  fx.trades.filter((t) => t.date === date).sort((a, b) => a.entryMin - b.entryMin || a.id.localeCompare(b.id));

/** How many losers in a row had closed just before `t` was entered (the same count a loss-streak check uses). */
function runBefore(fx: Fixture, t: FxTrade): number {
  const prior = fx.trades.filter((p) => p !== t && p.date === t.date && exitMin(p) <= t.entryMin).sort((a, b) => exitMin(b) - exitMin(a));
  let run = 0;
  for (const p of prior) {
    if (net(p) < 0) run++;
    else break;
  }
  return run;
}

/** Most recent closed trade of the day before time `at` (exit at or before it). */
function lastClosedBefore(fx: Fixture, t: FxTrade): FxTrade | undefined {
  return fx.trades
    .filter((p) => p !== t && p.date === t.date && exitMin(p) <= t.entryMin)
    .sort((a, b) => exitMin(b) - exitMin(a))[0];
}

function symbolForTrade(fx: Fixture, inst: Instrument, date: string): string {
  return symbolFor(inst, date, fx.rng);
}

function makeTrade(fx: Fixture, name: string, date: string, entryMin: number, hold: number, win: boolean, tags: string[] = []): FxTrade {
  const f = instOf(name);
  const t: FxTrade = {
    id: newId(fx),
    inst: f.inst,
    symbol: symbolForTrade(fx, f.inst, date),
    date,
    entryMin,
    hold,
    dir: 1,
    qty: f.inst.qty,
    pnl: 0,
    fees: drawFee(fx.rng, name),
    tags,
  };
  t.pnl = drawPnl(fx.rng, name, win);
  fx.trades.push(t);
  return t;
}

// ---------------------------------------------------------------------------
// Baseline: the neutral trader
// ---------------------------------------------------------------------------

export interface BaselineOpts {
  /** weekdays to trade, from `start` (default 20 from 2026-09-01) */
  days?: number;
  start?: string;
  name?: string;
}

export function baseline(seed: number, opts: BaselineOpts = {}): Fixture {
  const rng = new Rng(hashSeed('tradelens-fixture', seed));
  const start = opts.start ?? '2026-09-01';
  const days = weekdaysFrom(start, opts.days ?? 20);
  const extras = rng.shuffle(EXTRA).slice(0, rng.int(0, 2));
  const names = [...CORE, ...extras];
  const fx: Fixture = { name: opts.name ?? `baseline-${seed}`, seed, rng, days, trades: [], nextId: 1, planted: {} };

  // 5 or 6 trades a day; most days 6, so the typical day is 6 and nothing counts as overtrading
  const perDay = rng.shuffle(days.map((_, i) => (i % 5 === 0 || i % 5 === 3 ? 5 : 6)));
  const total = perDay.reduce((a, b) => a + b, 0);
  const labels = rng.shuffle(Array.from({ length: total }, (_, i) => names[i % names.length]));

  let cursor = 0;
  days.forEach((date, di) => {
    const todays = labels.slice(cursor, cursor + perDay[di]);
    cursor += perDay[di];
    for (let attempt = 0; attempt < 80; attempt++) {
      const wins = todays.map(() => rng.chance(P_WIN));
      const holds = todays.map(() => rng.int(5, 40));
      const items: PlaceItem[] = todays.map((name, i) => ({ key: name, hold: holds[i], loss: !wins[i] }));
      const entries = placeItems(items, rng);
      if (!entries) continue;
      todays.forEach((name, i) => {
        const t = makeTrade(fx, name, date, entries[i], holds[i], wins[i]);
        t.fees = drawFee(rng, name);
      });
      return;
    }
    throw new Error(`baseline: could not place ${date}`);
  });
  return fx;
}

// ---------------------------------------------------------------------------
// Planters. Each returns the ids of the trades it planted.
// ---------------------------------------------------------------------------

function record(fx: Fixture, key: string, ids: string[]): string[] {
  fx.planted[key] = [...(fx.planted[key] ?? []), ...ids];
  return ids;
}

/** One underlying keeps losing: low win rate and bigger losses on every trade in it. */
export function plantInstrumentBleed(fx: Fixture, o: { strength?: number; variant?: string } = {}): string[] {
  const s = o.strength ?? 1;
  const variant = o.variant ?? DEFAULT_BLEED_VARIANT;
  const mine = fx.trades.filter((t) => t.inst.underlying === variant);
  if (mine.length < 5) throw new Error(`plantInstrumentBleed: only ${mine.length} ${variant} trades`);
  const flags = winFlags(fx.rng, mine.length, P_WIN - 0.42 * s);
  mine.forEach((t, i) => setOutcome(fx, t, flags[i], 1 + 0.8 * s));
  return record(fx, `instrument-bleed:${variant}`, mine.map((t) => t.id));
}

/** Entries after the third straight loss of the day are losers too (trading on while tilted). */
export function plantLossStreak(fx: Fixture, o: { strength?: number } = {}): string[] {
  const s = o.strength ?? 1;
  const nDays = Math.max(1, Math.round(6 * s));
  // per day: the first three trades to close are losers; whatever is entered after the third closes is a loser too
  const plans = fx.days
    .map((date) => {
      const ts = fx.trades.filter((t) => t.date === date).sort((a, b) => exitMin(a) - exitMin(b));
      const streak = ts.slice(0, 3);
      const gate = streak.length === 3 ? exitMin(streak[2]) : Infinity;
      const after = ts.filter((t) => !streak.includes(t) && t.entryMin >= gate);
      return { streak, after, jitter: fx.rng.next() };
    })
    .filter((p) => p.after.length >= 2)
    .sort((a, b) => b.after.length + b.jitter - (a.after.length + a.jitter))
    .slice(0, nDays);
  for (const plan of plans) {
    for (const t of plan.streak) setOutcome(fx, t, false);
    const flags = winFlags(fx.rng, plan.after.length, 1 - 0.43 - 0.5 * s);
    plan.after.forEach((t, i) => setOutcome(fx, t, flags[i], 1 + 0.6 * s));
  }
  return record(fx, 'loss-streak', streakSet(fx));
}

/** Trades entered after >=3 consecutive losers (by close time) on the same day. */
export function streakSet(fx: Fixture): string[] {
  const out: string[] = [];
  for (const t of fx.trades) {
    const prior = fx.trades.filter((p) => p !== t && p.date === t.date && exitMin(p) <= t.entryMin).sort((a, b) => exitMin(b) - exitMin(a));
    let run = 0;
    for (const p of prior) {
      if (net(p) < 0) run++;
      else break;
    }
    if (run >= 3) out.push(t.id);
  }
  return out;
}

/** After a loss, jump back into the same instrument 2-10 minutes later at the same size, and lose again. */
export function plantQuickReentry(fx: Fixture, o: { strength?: number } = {}): string[] {
  const s = o.strength ?? 1;
  const want = Math.max(1, Math.round(10 * s));
  const ids: string[] = [];
  const flags = winFlags(fx.rng, want, P_WIN - 0.42 * s);
  // start from a loser that was not itself part of a losing run, so the planted trades do not also read as a loss streak
  const losers = fx.rng.shuffle(fx.trades.filter((t) => net(t) < 0 && runBefore(fx, t) === 0));
  for (const loser of losers) {
    if (ids.length >= want) break;
    // convert a later trade the same day into the re-entry (keeps the number of trades per day)
    const later = fx.rng.shuffle(
      fx.trades.filter((t) => t.date === loser.date && t !== loser && t.entryMin > exitMin(loser) && !ids.includes(t.id) && !fx.planted['quick-reentry']?.includes(t.id)),
    );
    for (const t of later) {
      const gap = fx.rng.int(2, 10);
      const entry = exitMin(loser) + gap;
      const hold = fx.rng.int(5, 15);
      if (entry + hold > 925) continue;
      const win = flags[ids.length];
      const sim: FxTrade = { ...t, inst: loser.inst, entryMin: entry, hold, symbol: loser.symbol, qty: loser.qty };
      if (!fitsSequential(fx, sim, [t.id, loser.id], !win)) continue;
      t.inst = loser.inst;
      t.symbol = loser.symbol;
      t.qty = loser.qty;
      t.entryMin = entry;
      t.hold = hold;
      t.fees = drawFee(fx.rng, loser.inst.underlying);
      setOutcome(fx, t, win, 1 + 0.5 * s);
      t.tags.push('reentry');
      ids.push(t.id);
      break;
    }
  }
  return record(fx, 'quick-reentry', ids);
}

/** True when `t` does not collide with other trades in the same underlying (ignoring `skip`). */
function fitsSequential(fx: Fixture, t: FxTrade, skip: string[], tLoses: boolean): boolean {
  for (const p of fx.trades) {
    if (p.date !== t.date || p.inst.underlying !== t.inst.underlying || skip.includes(p.id) || p.id === t.id) continue;
    if (t.entryMin >= exitMin(p)) {
      if (t.entryMin - exitMin(p) < (net(p) < 0 ? 26 : 16)) return false;
    } else if (p.entryMin >= exitMin(t)) {
      if (p.entryMin - exitMin(t) < (tLoses ? 26 : 16)) return false;
    } else return false;
  }
  return true;
}

/** On a few days, keep trading past your usual count, and the extra trades lose. */
export function plantOvertrading(fx: Fixture, o: { strength?: number; extras?: number } = {}): string[] {
  const s = o.strength ?? 1;
  const nDays = Math.max(1, Math.round(5 * s));
  const extras = o.extras ?? 3;
  const days = fx.rng.shuffle(fx.days.filter((d) => fx.trades.filter((t) => t.date === d).length === 6)).slice(0, nDays);
  const ids: string[] = [];
  const names = Object.keys(FX).filter((n) => fx.trades.some((t) => t.inst.underlying === n));
  const flags = winFlags(fx.rng, days.length * extras, P_WIN - 0.42 * s);
  let flagAt = 0;
  for (const date of days) {
    const added: FxTrade[] = [];
    for (let k = 0; k < extras; k++) {
      const name = fx.rng.pick(names);
      const win = flags[flagAt++];
      const t = makeTrade(fx, name, date, 0, fx.rng.int(5, 14), win, ['extra']);
      setOutcome(fx, t, win, 1 + 0.5 * s);
      added.push(t);
    }
    // the usual six finish by 12:50, the extras come after
    const ok = replaceDay(fx, date, (t, item) => {
      if (added.includes(t)) item.min = 13 * 60;
      else item.max = 12 * 60 + 50;
    });
    if (!ok) {
      for (const t of added) fx.trades.splice(fx.trades.indexOf(t), 1);
      continue;
    }
    ids.push(...added.map((t) => t.id));
  }
  return record(fx, 'overtrading', ids);
}

/** Trades opened in one time window lose: low win rate, bigger losses. */
export function plantTimeWindow(fx: Fixture, o: { strength?: number; variant?: WindowName } = {}): string[] {
  const s = o.strength ?? 1;
  const variant = o.variant ?? (DEFAULT_WINDOW_VARIANT as WindowName);
  const [a, z] = WINDOWS[variant];
  const inside = fx.trades.filter((t) => t.entryMin >= a && t.entryMin < z);
  if (inside.length < 5) throw new Error(`plantTimeWindow: only ${inside.length} trades in ${variant}`);
  const flags = winFlags(fx.rng, inside.length, P_WIN - 0.45 * s);
  inside.forEach((t, i) => setOutcome(fx, t, flags[i], 1 + 0.5 * s));
  return record(fx, `time-window:${variant}`, inside.map((t) => t.id));
}

/** Buy the NIFTY weekly that expires today, on every Tuesday; most of them lose. */
export function plantExpiryDay(fx: Fixture, o: { strength?: number } = {}): string[] {
  const s = o.strength ?? 1;
  const perDay = Math.max(1, Math.round(4 * s));
  const nifty = instOf('NIFTY');
  const ids: string[] = [];
  const tuesdays = fx.days.filter(isTuesday);
  const flags = winFlags(fx.rng, tuesdays.length * perDay, P_WIN - 0.4 * s);
  let flagAt = 0;
  for (const date of tuesdays) {
    const ts = tradesOn(fx, date);
    const pick = fx.rng.shuffle(ts).slice(0, perDay);
    for (const t of pick) {
      t.inst = nifty.inst;
      t.qty = nifty.inst.qty;
      const strike = 25000 + fx.rng.int(-3, 3) * 50;
      t.symbol = niftySymbol(date, strike, fx.rng.chance(0.5) ? 'CE' : 'PE');
      t.fees = drawFee(fx.rng, 'NIFTY');
      setOutcome(fx, t, flags[flagAt++], 1 + 1.5 * s);
      t.tags.push('expiry');
      ids.push(t.id);
    }
    // converting to NIFTY may collide with the day's other NIFTY trades; re-place the day
    if (!replaceDay(fx, date)) throw new Error(`plantExpiryDay: cannot place ${date}`);
  }
  return record(fx, 'expiry-day', ids);
}

/** Winners are taken quickly, losers are held for ages and grow. `strength` is the share of losers held long. */
export function plantHoldingLosers(fx: Fixture, o: { strength?: number } = {}): string[] {
  const s = o.strength ?? 1;
  const rng = fx.rng;
  const ids: string[] = [];
  for (const t of fx.trades) {
    if (net(t) > 0) {
      t.hold = rng.int(6, 20);
    } else if (rng.chance(clamp01(s))) {
      t.hold = rng.int(55, 110);
      setOutcome(fx, t, false, 1 + 1.2 * s);
      t.tags.push('held');
      ids.push(t.id);
    } else {
      t.hold = rng.int(6, 20);
    }
  }
  for (const date of fx.days) {
    if (!replaceDay(fx, date)) {
      // not enough room that day: shorten the long holds there
      for (const t of fx.trades.filter((x) => x.date === date)) t.hold = Math.min(t.hold, 70);
      if (!replaceDay(fx, date, undefined, 200)) throw new Error(`plantHoldingLosers: cannot place ${date}`);
    }
  }
  return record(fx, 'holding-losers', ids);
}

/** After a loss, the next trade is twice the usual size, and tends to lose. */
export function plantSizeAfterLoss(fx: Fixture, o: { strength?: number } = {}): string[] {
  const s = o.strength ?? 1;
  const want = Math.max(1, Math.round(14 * s));
  const ids: string[] = [];
  const flags = winFlags(fx.rng, want, P_WIN - 0.35 * s);
  const cands = fx.rng.shuffle(fx.trades.filter((t) => t.inst.lot < 500 && lastClosedBefore(fx, t) !== undefined && net(lastClosedBefore(fx, t)!) < 0 && runBefore(fx, t) === 1));
  for (const t of cands) {
    if (ids.length >= want) break;
    const base = t.inst.qty;
    const lot = t.inst.lot;
    const qty = Math.max(lot, Math.round((base * (1 + s)) / lot) * lot);
    if (qty < 1.5 * base) continue; // too small a bump to count as sizing up
    t.qty = qty;
    setOutcome(fx, t, flags[ids.length], 1 + 0.2 * s);
    t.tags.push('sized-up');
    ids.push(t.id);
  }
  return record(fx, 'size-after-loss', ids);
}

/** Scalps whose price move barely covers the charges. */
export function plantFeeChurn(fx: Fixture, o: { strength?: number } = {}): string[] {
  const s = o.strength ?? 1;
  const want = Math.max(1, Math.round(30 * s));
  const ids: string[] = [];
  const cands = fx.rng.shuffle(fx.trades.filter((t) => ['NIFTY', 'BANKNIFTY'].includes(t.inst.underlying)));
  for (const t of cands.slice(0, want)) {
    t.pnl = Math.round(fx.rng.normal(4, 40) * 100) / 100;
    t.fees = Math.round(fx.rng.float(58, 78) * 100) / 100;
    t.tags.push('scalp');
    ids.push(t.id);
  }
  return record(fx, 'fee-churn', ids);
}

/**
 * Confound: one underlying loses, and only ever trades in the closing window,
 * while every other trade in that window wins. The honest finding is the
 * instrument, not the time of day.
 */
export function plantSymbolVsTime(fx: Fixture, o: { underlying?: string } = {}): { symbol: string; ids: string[] } {
  const u = o.underlying ?? 'INFY';
  const other = 'HDFCBANK';
  const rng = fx.rng;
  // at most one trade of u per day: the closing window only fits one
  const seen = new Set<string>();
  for (const t of fx.trades.filter((x) => x.inst.underlying === u).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.entryMin - b.entryMin))) {
    if (seen.has(t.date)) {
      const f = instOf(other);
      t.inst = f.inst;
      t.qty = f.inst.qty;
      t.symbol = symbolForTrade(fx, f.inst, t.date);
      t.fees = drawFee(rng, other);
      setOutcome(fx, t, true);
    }
    seen.add(t.date);
  }
  const mine = fx.trades.filter((t) => t.inst.underlying === u);
  const flags = winFlags(rng, mine.length, 0.12);
  mine.forEach((t, i) => {
    t.hold = rng.int(5, 25);
    setOutcome(fx, t, flags[i], 1.6);
  });
  for (const date of fx.days) {
    const ts = fx.trades.filter((t) => t.date === date);
    for (let k = 0; k < 80; k++) {
      const items = ts.map((t): PlaceItem => {
        const item = toItem(t);
        if (t.inst.underlying === u) item.min = 885;
        return item;
      });
      const entries = placeItems(items, rng);
      if (!entries) continue;
      ts.forEach((t, i) => (t.entryMin = entries[i]));
      break;
    }
  }
  // everybody else who trades in the closing window wins
  for (const t of fx.trades) {
    if (t.inst.underlying !== u && t.entryMin >= 885) setOutcome(fx, t, true);
  }
  return { symbol: u, ids: record(fx, `instrument-bleed:${u}`, mine.map((t) => t.id)) };
}

/** Apply the planter for a habit kind with its default variant. */
export function plant(fx: Fixture, kind: HabitKind, strength = 1, variant?: string): string[] {
  switch (kind) {
    case 'instrument-bleed':
      return plantInstrumentBleed(fx, { strength, variant });
    case 'loss-streak':
      return plantLossStreak(fx, { strength });
    case 'quick-reentry':
      return plantQuickReentry(fx, { strength });
    case 'overtrading':
      return plantOvertrading(fx, { strength });
    case 'time-window':
      return plantTimeWindow(fx, { strength, variant: variant as WindowName | undefined });
    case 'expiry-day':
      return plantExpiryDay(fx, { strength });
    case 'holding-losers':
      return plantHoldingLosers(fx, { strength });
    case 'size-after-loss':
      return plantSizeAfterLoss(fx, { strength });
    case 'fee-churn':
      return plantFeeChurn(fx, { strength });
  }
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

const sorted = (fx: Fixture) => [...fx.trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.entryMin - b.entryMin || a.id.localeCompare(b.id)));

export const CLOSED_HEADER = 'id,symbol,entry_time,exit_time,pnl,fees,quantity';

export function toClosedRows(fx: Fixture): (string | number)[][] {
  return sorted(fx).map((t) => [
    t.id,
    t.symbol,
    stamp(t.date, t.entryMin, 0),
    stamp(t.date, exitMin(t), 0),
    t.pnl.toFixed(2),
    t.fees.toFixed(2),
    t.qty,
  ]);
}

export function toClosedCsv(fx: Fixture, eol = '\n'): string {
  return [CLOSED_HEADER, ...toClosedRows(fx).map((r) => r.join(','))].join(eol) + eol;
}

export interface FillsOut {
  csv: string;
  rows: FillRow[];
  /** key `${symbol}|${first fill time}` -> fixture trade id, to map engine trades back to planted ids */
  keys: Map<string, string>;
}

/** Decompose each closed trade into executions (some with scale-ins, partial exits and shorts). */
export function toFillsCsv(fx: Fixture, eol = '\n'): FillsOut {
  const rng = new Rng(hashSeed('fills', fx.seed, fx.name));
  const rows: FillRow[] = [];
  const keys = new Map<string, string>();
  let tradeNo = 7_000_000;
  let orderNo = 2_609_000_000_000;
  const ids = {
    nextTrade: () => String((tradeNo += rng.int(2, 30))),
    nextOrder: () => String((orderNo += rng.int(3, 200))),
  };
  for (const t of sorted(fx)) {
    const inst = t.inst;
    const isOption = inst.kind === 'NIFTY' || inst.kind === 'BANKNIFTY';
    // shorts are only for futures/equities
    const dir: 1 | -1 = !isOption && rng.chance(0.08) ? -1 : 1;
    const move = t.pnl / t.qty; // price change per unit in the direction of the trade (+ = profit)
    let entryPrice: number;
    if (isOption) entryPrice = roundTick(rng.float(inst.kind === 'NIFTY' ? 70 : 150, inst.kind === 'NIFTY' ? 230 : 420));
    else entryPrice = roundTick(inst.price * rng.float(0.985, 1.015));
    // a long that loses must still have a positive exit price
    if (dir * move < 0) entryPrice = Math.max(entryPrice, Math.abs(move) * 1.3 + 5);
    const exitFinal = Math.max(0.05, roundTick(entryPrice + dir * move));
    const canSplit = inst.qty / inst.lot >= 2;
    const entryFills = canSplit && rng.chance(0.2) ? 2 : 1;
    const exitFills = canSplit && rng.chance(0.2) ? (inst.qty / inst.lot >= 3 && rng.chance(0.4) ? 3 : 2) : 1;
    const entrySec = t.entryMin * 60 + rng.int(0, 59);
    const exitSec = exitMin(t) * 60 + rng.int(0, 59);
    const legs = makeLegs({ dir, qty: t.qty, lot: inst.lot, entryPrice, exitPrice: exitFinal, entrySec, exitSec, entryFills, exitFills, rng });
    const tradeRows = legsToRows(t.symbol, inst, t.date, legs, ids, rng, 0.05);
    rows.push(...tradeRows);
    keys.set(`${t.symbol}|${tradeRows[0].time}`, t.id);
  }
  rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return { csv: fillsToCsv(rows, eol), rows, keys };
}
