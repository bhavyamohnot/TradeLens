// Deterministic generator for the demo dataset: a fictional retail trader's
// September 2026 NSE F&O + equity tradebook, in Zerodha-Console style.
//
//   npm run samples
//
// Everything is driven by a seeded PRNG, so running it twice produces
// byte-identical files. The generator plants three habits (expiry-day option
// buying, quick re-entry after a loss, holding losers) and several decoys that
// a good review must NOT flag; the answer key records both, computed from the
// generated fills without touching the analysis engine.

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import {
  BANKNIFTY,
  FILL_HEADER,
  HDFCBANK,
  INFY,
  NIFTY,
  RELIANCE,
  Rng,
  episodesFromRows,
  fillsToCsv,
  hashSeed,
  isTuesday,
  MIN_0915,
  MIN_0945,
  MIN_1525,
  legsToRows,
  makeLegs,
  monthlySymbol,
  nextTuesday,
  niftySymbol,
  round2,
  roundTick,
  stamp,
  symbolFor,
  weekdaysInMonth,
  type FillRow,
  type Instrument,
  type Leg,
} from '../evals/common';
import { estimateCharges } from '../src/engine/charges';
import { parseSymbol } from '../src/engine/symbols';

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'public', 'samples');
const BASE_NAME = 'sept-2026-tradebook';
const HOLIDAYS = ['2026-09-14'];


// ---------------------------------------------------------------------------
// Placing a day's trades on the clock
// ---------------------------------------------------------------------------

interface Placed {
  slot: Slot;
  entry: number; // minute of day
  exit: number;
}

const WIN_GAP = 4; // minutes between a winner's exit and the next trade in the same underlying
const LOSS_GAP = 26; // after a loser: more than 25 minutes, so nothing else looks like a quick re-entry

/**
 * Trades in different underlyings may overlap (a trader can sit in a loser while taking another trade),
 * but within one underlying they are strictly sequential, with a gap after a loser of 26+ minutes.
 */
function fits(placed: Placed[], slot: Slot, entry: number, exit: number, skip?: Slot): boolean {
  for (const p of placed) {
    if (p.slot === skip || p.slot.inst.underlying !== slot.inst.underlying) continue;
    if (entry >= p.exit) {
      if (entry - p.exit < (p.slot.win ? WIN_GAP : LOSS_GAP)) return false;
    } else if (p.entry >= exit) {
      if (p.entry - exit < (slot.win ? WIN_GAP : LOSS_GAP)) return false;
    } else return false;
  }
  return true;
}

// [from, to) minute of day, for morning / midday / afternoon / closing
const WINDOWS: [number, number][] = [
  [585, 690],
  [690, 810],
  [810, 885],
  [885, 925],
];
const LONG_WINDOW_WEIGHTS = [0.3, 0.4, 0.3, 0];
const SHORT_WINDOW_WEIGHTS = [0.27, 0.3, 0.21, 0.22];

function pickWindow(rng: Rng, weights: number[]): [number, number] {
  let u = rng.next();
  for (let i = 0; i < weights.length; i++) {
    u -= weights[i];
    if (u < 0) return WINDOWS[i];
  }
  return WINDOWS[0];
}

function placeDay(
  rng: Rng,
  opening: Slot[],
  free: Slot[],
  pair: { trigger: Slot; reentry: Slot } | undefined,
  lastExit: number,
): Placed[] | null {
  const placed: Placed[] = [];
  // opening half hour: one or two quick winners, one after the other
  let t = MIN_0915 + rng.int(0, 4);
  for (const s of opening) {
    placed.push({ slot: s, entry: t, exit: t + s.hold });
    t += s.hold + rng.int(3, 5);
  }
  const first = MIN_0945 + 1;
  const items: { slots: Slot[]; span: number }[] = free.map((s) => ({ slots: [s], span: s.hold }));
  if (pair) items.push({ slots: [pair.trigger, pair.reentry], span: pair.trigger.hold + pair.reentry.pinGap! + pair.reentry.hold });
  items.sort((a, b) => b.span - a.span);
  for (const item of items) {
    let ok = false;
    for (let tries = 0; tries < 300 && !ok; tries++) {
      // pick a window first: long holds cannot start late, so they are spread over the first three windows
      const w = item.slots[0].window !== undefined && tries < 60 ? WINDOWS[item.slots[0].window] : pickWindow(rng, item.span >= 45 ? LONG_WINDOW_WEIGHTS : SHORT_WINDOW_WEIGHTS);
      const lo = Math.max(first, w[0]);
      const hi = Math.min(w[1] - 1, lastExit - item.span);
      if (hi < lo) continue;
      const entry = rng.int(lo, hi);
      if (item.slots.length === 1) {
        const s = item.slots[0];
        if (!fits(placed, s, entry, entry + s.hold)) continue;
        placed.push({ slot: s, entry, exit: entry + s.hold });
      } else {
        const [trig, re] = item.slots;
        const reEntry = entry + trig.hold + re.pinGap!;
        if (!fits(placed, trig, entry, entry + trig.hold) || !fits(placed, re, reEntry, reEntry + re.hold, trig)) continue;
        placed.push({ slot: trig, entry, exit: entry + trig.hold }, { slot: re, entry: reEntry, exit: reEntry + re.hold });
      }
      ok = true;
    }
    if (!ok) return null;
  }
  // never three losers in a row, counted the way a reviewer would: the trades that had already closed
  for (const p of placed) {
    const closed = placed.filter((q) => q !== p && q.exit <= p.entry).sort((a, b) => b.exit - a.exit);
    let run = 0;
    for (const q of closed) {
      if (q.slot.win) break;
      run++;
    }
    if (run >= 3) return null;
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

type Role = 'open-win' | 'win' | 'long-loss' | 'quick-loss' | 'expiry' | 'trigger' | 'reentry' | 'one-off';

interface Slot {
  role: Role;
  inst: Instrument;
  win: boolean;
  hold: number;
  dir: 1 | -1;
  /** reentry slots: minutes after the trigger's exit */
  pinGap?: number;
  /** for triggers: the re-entry that follows */
  pairId?: number;
  /** target time window: 0 morning, 1 midday, 2 afternoon, 3 closing */
  window?: number;
  // filled in later
  date?: string;
  gross?: number; // target gross P&L
  raw?: number;
}

const INSTRUMENTS: Record<string, Instrument> = {
  NIFTY: { ...NIFTY, qty: 195 },
  BANKNIFTY: { ...BANKNIFTY, qty: 90 },
  RELIANCE: { ...RELIANCE, qty: 500 },
  HDFCBANK: { ...HDFCBANK, qty: 200 },
  INFY: { ...INFY, qty: 150 },
};

// Counts of ordinary (non-planted) slots by instrument and role.
// wins include the opening-half-hour winners; longLoss excludes the triggers, which are extra long losers
// that a quick re-entry follows (triggers + longLoss = 37 long-held losers in all).
const ORDINARY: Record<string, { wins: number; longLoss: number; quickLoss: number; triggers: number }> = {
  RELIANCE: { wins: 7, longLoss: 2, quickLoss: 1, triggers: 2 },
  HDFCBANK: { wins: 14, longLoss: 5, quickLoss: 1, triggers: 2 },
  INFY: { wins: 12, longLoss: 6, quickLoss: 1, triggers: 3 },
  NIFTY: { wins: 22, longLoss: 8, quickLoss: 1, triggers: 0 },
  BANKNIFTY: { wins: 24, longLoss: 4, quickLoss: 1, triggers: 5 }, // longLoss includes the one-off
};
const OPENING_WINS = 30;
const SHORT_WINS = 5; // short-first trades (sell, then buy back)
const EXPIRY_COUNTS = [5, 5, 5, 5, 5]; // five expiring-weekly buys on each Tuesday, 25 in all
const EXPIRY_WINS = 5; // ~20% win rate
const REENTRY_WINS = 3; // ~25% win rate

// Targets (gross, rupees)
const TARGET_EXPIRY = -28_000;
const TARGET_REENTRY = -14_000;
const TARGET_ORDINARY: Record<string, number> = { RELIANCE: 12_000, NIFTY: 5_000, BANKNIFTY: 3_000, HDFCBANK: 1_000, INFY: 1_000 };
const ONE_OFF_LOSS = -6_000;

// Base sizes (before calibration)
const LONG_LOSS_MEAN: Record<string, number> = { RELIANCE: 2_200, NIFTY: 1_580, BANKNIFTY: 1_580, HDFCBANK: 1_440, INFY: 1_490 };
const WIN_MEAN: Record<string, number> = { RELIANCE: 3_150, NIFTY: 900, BANKNIFTY: 950, HDFCBANK: 860, INFY: 1_300 };
const QUICK_LOSS_RATIO = 0.4;
const OPENING_WIN_RATIO = 0.6; // many small, reliable opening-range winners
// floor on |gross| per underlying so estimated charges never flip a trade's sign or look like fee churn
const MIN_GROSS: Record<string, number> = { RELIANCE: 1_700, NIFTY: 450, BANKNIFTY: 450, HDFCBANK: 700, INFY: 700 };
const EXPIRY_LOSS_MEAN = 1_900;
const EXPIRY_WIN_MEAN = 1_000;
const REENTRY_LOSS_MEAN = 1_750;
const REENTRY_WIN_MEAN = 600;

interface Built {
  rows: FillRow[];
  trades: BuiltTrade[];
  open: { symbol: string; qty: number; time: string };
}

interface BuiltTrade {
  role: Role;
  symbol: string;
  underlying: string;
  date: string;
  entryTime: string;
  exitTime: string;
  entrySec: number;
  exitSec: number;
  gross: number;
  fees: number;
  qty: number;
  turnover: number;
  dir: 1 | -1;
  fills: number;
}

class Retry extends Error {}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Retry(msg);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function buildOnce(attempt: number): Built {
  const rng = new Rng(hashSeed('tradelens-sample', 2026, 9, attempt));
  const days = weekdaysInMonth(2026, 9, HOLIDAYS);
  check(days.length === 21, `expected 21 trading days, got ${days.length}`);
  const tuesdays = days.filter(isTuesday);
  const others = days.filter((d) => !isTuesday(d));

  // --- how many trades each day ---------------------------------------
  const counts = new Map<string, number>();
  tuesdays.forEach((d) => counts.set(d, 8));
  const otherCounts = rng.shuffle([...Array(10).fill(8), 7, 7, 6, 6, 6, 6]);
  others.forEach((d, i) => counts.set(d, otherCounts[i]));

  // --- slots ----------------------------------------------------------
  const expirySlots: Slot[] = [];
  const dayExpiry = new Map<string, Slot[]>();
  tuesdays.forEach((d, i) => {
    const list: Slot[] = [];
    for (let k = 0; k < EXPIRY_COUNTS[i]; k++) {
      list.push({ role: 'expiry', inst: INSTRUMENTS.NIFTY, win: k === 0, hold: 0, dir: 1, date: d });
    }
    dayExpiry.set(d, list);
    expirySlots.push(...list);
  });
  check(expirySlots.length === 25 && expirySlots.filter((s) => s.win).length === EXPIRY_WINS, 'expiry slot counts');
  expirySlots.forEach((s) => {
    s.hold = s.win ? rng.int(8, 18) : rng.int(6, 18);
  });

  // re-entry pairs on 12 non-Tuesday days with 7+ trades
  const reentryDays = rng.shuffle(others.filter((d) => counts.get(d)! >= 7));
  check(reentryDays.length === 12, 're-entry day count');
  const pairInst: string[] = [];
  for (const [name, c] of Object.entries(ORDINARY)) for (let k = 0; k < c.triggers; k++) pairInst.push(name);
  const shuffledPairInst = rng.shuffle(pairInst);
  const reWinIdx = new Set(rng.shuffle([...Array(12).keys()]).slice(0, REENTRY_WINS));
  const dayPair = new Map<string, { trigger: Slot; reentry: Slot }>();
  reentryDays.forEach((d, i) => {
    const inst = INSTRUMENTS[shuffledPairInst[i]];
    const trigger: Slot = { role: 'trigger', inst, win: false, hold: rng.int(45, 105), dir: 1, pairId: i, date: d };
    const reentry: Slot = {
      role: 'reentry',
      inst,
      win: reWinIdx.has(i),
      hold: rng.int(6, 18),
      dir: 1,
      pinGap: rng.int(2, 10),
      pairId: i,
      date: d,
    };
    dayPair.set(d, { trigger, reentry });
  });

  // ordinary non-trigger slots
  const pool: Slot[] = [];
  const winSlots: Slot[] = [];
  for (const [name, c] of Object.entries(ORDINARY)) {
    const inst = INSTRUMENTS[name];
    for (let k = 0; k < c.wins; k++) winSlots.push({ role: 'win', inst, win: true, hold: rng.int(6, 20), dir: 1 });
    for (let k = 0; k < c.longLoss; k++) {
      pool.push({ role: 'long-loss', inst, win: false, hold: rng.int(45, 105), dir: 1 });
    }
    for (let k = 0; k < c.quickLoss; k++) pool.push({ role: 'quick-loss', inst, win: false, hold: rng.int(6, 18), dir: 1 });
  }
  check(winSlots.length === 79, 'win slot count');
  // one BANKNIFTY long loser is the one-off decoy
  const oneOff = pool.find((s) => s.role === 'long-loss' && s.inst.underlying === 'BANKNIFTY')!;
  oneOff.role = 'one-off';
  oneOff.hold = rng.int(60, 100);
  pool.splice(pool.indexOf(oneOff), 1);

  // opening winners and short-first winners
  const shuffledWins = rng.shuffle(winSlots);
  const openWins = shuffledWins.slice(0, OPENING_WINS);
  openWins.forEach((s) => {
    s.role = 'open-win';
    s.hold = rng.int(6, 11);
  });
  const shortable = shuffledWins.slice(OPENING_WINS).filter((s) => s.inst.kind !== 'NIFTY' && s.inst.kind !== 'BANKNIFTY');
  shortable.slice(0, SHORT_WINS).forEach((s) => (s.dir = -1));
  check(shortable.length >= SHORT_WINS, 'not enough shortable trades');

  // --- spread every kind of trade evenly over the time windows ----------
  // (without this, long holds pile up in the morning and a time window looks bad by chance)
  const assignWindows = (slots: Slot[], counts: number[]) => {
    check(slots.length === counts.reduce((a, b) => a + b, 0), `window counts for ${slots[0]?.role}`);
    const list = rng.shuffle(counts.flatMap((n, w) => Array<number>(n).fill(w)));
    slots.forEach((slot, i) => (slot.window = list[i]));
  };
  // each Tuesday: one expiry buy in the afternoon, one in the last 45 minutes, the other three before 13:30
  const morningPerDay = rng.shuffle([1, 1, 2, 1, 2]);
  tuesdays.forEach((d, i) => {
    // sorted by time; the winner takes the middle slot so no trade follows three straight expiry losers
    const ws = [...Array<number>(morningPerDay[i]).fill(0), ...Array<number>(3 - morningPerDay[i]).fill(1), 2, 3];
    const slots = dayExpiry.get(d)!;
    const winner = slots.find((x) => x.win)!;
    const losers = slots.filter((x) => !x.win);
    winner.window = ws[2];
    const rest = ws.filter((_, k) => k !== 2);
    losers.forEach((x, k) => (x.window = rest[k]));
  });
  assignWindows([...dayPair.values()].map((p) => p.trigger), [4, 4, 4, 0]);
  assignWindows(pool.filter((x) => x.role === 'long-loss').concat(oneOff), [9, 10, 6, 0]);
  assignWindows(pool.filter((x) => x.role === 'quick-loss'), [1, 2, 1, 1]);
  assignWindows(shuffledWins.slice(OPENING_WINS), [11, 13, 15, 10]);
  // a long hold cannot start late: afternoon long losers are the shorter ones (still 2x+ the winners' hold)
  for (const x of [...pool, oneOff, ...[...dayPair.values()].map((p) => p.trigger)]) {
    if (x.window === 2 && x.hold > 62) x.hold = rng.int(46, 62);
  }

  // --- deal slots to days ---------------------------------------------
  const daySlots = new Map<string, Slot[]>();
  days.forEach((d) => daySlots.set(d, []));
  // 1 opening winner a day, 9 days get a second
  const openingList = [...openWins];
  const openingDays = [...days];
  const extraOpening = rng.shuffle(reentryDays).slice(0, OPENING_WINS - days.length);
  for (const d of [...openingDays, ...extraOpening]) daySlots.get(d)!.push(openingList.pop()!);
  check(openingList.length === 0, 'opening winners not all placed');

  const capacity = (d: string) =>
    counts.get(d)! - (dayExpiry.get(d)?.length ?? 0) - (dayPair.has(d) ? 2 : 0) - daySlots.get(d)!.length;
  // Long-held losers are spread evenly (they eat the clock): 1 per Tuesday, 1 per re-entry day, 2 on
  // each of the four quiet days (the one-off is one of them).
  const longPool = rng.shuffle(pool.filter((s) => s.role === 'long-loss'));
  const quota = new Map<string, number>();
  for (const d of days) quota.set(d, isTuesday(d) ? 1 : dayPair.has(d) ? 1 : 2);
  const quietDays = others.filter((d) => !dayPair.has(d));
  const oneOffDay = rng.pick(quietDays);
  daySlots.get(oneOffDay)!.push(oneOff);
  quota.set(oneOffDay, 1);
  // Tuesdays are already full of NIFTY (the expiring contract), so their other slots avoid it
  const take = (list: Slot[], avoidNifty: boolean): Slot => {
    const i = avoidNifty ? list.findIndex((x) => x.inst.underlying !== 'NIFTY') : list.length - 1;
    check(i >= 0, 'no non-NIFTY slot left for a Tuesday');
    return list.splice(i, 1)[0];
  };
  for (const d of days.filter(isTuesday)) {
    for (let k = 0; k < quota.get(d)!; k++) daySlots.get(d)!.push(take(longPool, true));
  }
  for (const d of days.filter((x) => !isTuesday(x))) {
    for (let k = 0; k < quota.get(d)!; k++) {
      const s = longPool.pop();
      if (s) daySlots.get(d)!.push(s);
    }
  }
  check(longPool.length === 0, `${longPool.length} long losers left over`);
  // Tuesdays carry four expiry losers, so their other slots must be winners (no three losers in a row).
  const restWins = rng.shuffle(shuffledWins.slice(OPENING_WINS));
  const restLosses = rng.shuffle(pool.filter((s) => s.role === 'quick-loss'));
  for (const d of tuesdays) {
    for (let k = capacity(d); k > 0; k--) daySlots.get(d)!.push(take(restWins, true));
  }
  const rest = rng.shuffle([...restLosses, ...restWins]);
  const caps = new Map(days.map((d) => [d, capacity(d)]));
  check([...caps.values()].every((c) => c >= 0), 'negative capacity');
  check([...caps.values()].reduce((a, b) => a + b, 0) === rest.length, 'capacity does not match slot count');
  for (const d of days) {
    for (let k = 0; k < caps.get(d)!; k++) daySlots.get(d)!.push(rest.pop()!);
  }

  // --- time every day ---------------------------------------------------
  const scheduled: { slot: Slot; date: string; entryMin: number }[] = [];
  for (const d of days) {
    const opening = daySlots.get(d)!.filter((s) => s.role === 'open-win');
    const free = [...daySlots.get(d)!.filter((s) => s.role !== 'open-win'), ...(dayExpiry.get(d) ?? [])];
    const lastExit = d === days[days.length - 1] ? 15 * 60 + 10 : MIN_1525;
    let placed: Placed[] | null = null;
    for (let tries = 0; tries < 300 && !placed; tries++) placed = placeDay(rng, opening, free, dayPair.get(d), lastExit);
    if (!placed && process.env.DEBUG_SAMPLE) {
      const all = [...opening, ...free, ...(dayPair.get(d) ? [dayPair.get(d)!.trigger, dayPair.get(d)!.reentry] : [])];
      console.error('FAIL', d, all.map((x) => `${x.role}/${x.inst.underlying}/w${x.window ?? '-'}/h${x.hold}`).join(' '));
    }
    check(placed !== null, `could not place ${d}`);
    for (const p of placed!) scheduled.push({ slot: p.slot, date: d, entryMin: p.entry });
  }

  // --- P&L targets ------------------------------------------------------
  const slotsAll = scheduled.map((x) => x.slot);
  const jitter = (sd: number) => clamp(rng.normal(1, sd), 0.55, 1.6);
  for (const s of slotsAll) {
    const u = s.inst.underlying;
    switch (s.role) {
      case 'open-win':
        s.raw = WIN_MEAN[u] * OPENING_WIN_RATIO * jitter(0.2);
        break;
      case 'win':
        s.raw = WIN_MEAN[u] * jitter(0.2);
        break;
      case 'long-loss':
      case 'trigger':
        s.raw = -LONG_LOSS_MEAN[u] * jitter(0.18);
        break;
      case 'quick-loss':
        s.raw = -LONG_LOSS_MEAN[u] * QUICK_LOSS_RATIO * jitter(0.2);
        break;
      case 'one-off':
        s.raw = ONE_OFF_LOSS;
        break;
      case 'expiry':
        s.raw = s.win ? EXPIRY_WIN_MEAN * jitter(0.2) : -EXPIRY_LOSS_MEAN * jitter(0.3);
        break;
      case 'reentry':
        s.raw = s.win ? REENTRY_WIN_MEAN * jitter(0.2) : -REENTRY_LOSS_MEAN * jitter(0.25);
        break;
    }
    s.raw = Math.sign(s.raw) * Math.max(Math.abs(s.raw), MIN_GROSS[s.inst.underlying]);
    s.gross = s.raw;
  }
  // calibrate: expiry and re-entry losers so the planted totals hit their targets
  const scaleLosers = (slots: Slot[], target: number) => {
    const wins = slots.filter((s) => s.win).reduce((a, s) => a + s.raw!, 0);
    const losses = slots.filter((s) => !s.win).reduce((a, s) => a + s.raw!, 0);
    const f = (target - wins) / losses;
    check(f > 0.5 && f < 2, `loser scale ${f.toFixed(2)} out of range`);
    slots.filter((s) => !s.win).forEach((s) => (s.gross = s.raw! * f));
  };
  scaleLosers(slotsAll.filter((s) => s.role === 'expiry'), TARGET_EXPIRY);
  scaleLosers(slotsAll.filter((s) => s.role === 'reentry'), TARGET_REENTRY);
  // (floors are re-applied after calibration below)
  // calibrate: ordinary winners per instrument so each underlying's ordinary gross hits its target
  for (const u of Object.keys(ORDINARY)) {
    const mine = slotsAll.filter((s) => s.inst.underlying === u && !['expiry', 'reentry'].includes(s.role));
    const wins = mine.filter((s) => s.win).reduce((a, s) => a + s.raw!, 0);
    const losses = mine.filter((s) => !s.win).reduce((a, s) => a + s.raw!, 0);
    const f = (TARGET_ORDINARY[u] - losses) / wins;
    check(f > 0.6 && f < 1.9, `${u} winner scale ${f.toFixed(2)} out of range`);
    mine.filter((s) => s.win).forEach((s) => (s.gross = s.raw! * f));
  }
  for (const s of slotsAll) s.gross = Math.sign(s.gross!) * Math.max(Math.abs(s.gross!), MIN_GROSS[s.inst.underlying]);

  // --- prices and fills -------------------------------------------------
  const rows: FillRow[] = [];
  const built: BuiltTrade[] = [];
  let tradeSeq = 0;
  let orderSeq = 0;
  const ids = {
    nextTrade: () => String(10_000_000 + ++tradeSeq * 7 + rng.int(0, 5)),
    nextOrder: () => String(2_609_000_000_000 + ++orderSeq * 131 + rng.int(0, 90)),
  };
  const drift = new Map<string, number>(); // per-day base price per underlying
  for (const d of days) {
    drift.set(`NIFTY|${d}`, 25_000 + Math.round(rng.normal(0, 150) / 50) * 50);
    drift.set(`BANKNIFTY|${d}`, 55_000 + Math.round(rng.normal(0, 350) / 100) * 100);
    drift.set(`RELIANCE|${d}`, round2(1_400 + rng.normal(0, 12)));
    drift.set(`HDFCBANK|${d}`, round2(1_000 + rng.normal(0, 8)));
    drift.set(`INFY|${d}`, round2(1_500 + rng.normal(0, 12)));
  }

  for (const { slot, date, entryMin } of scheduled) {
    const inst = slot.inst;
    const u = inst.underlying;
    const qty = inst.qty;
    const gross = slot.gross!;
    let symbol: string;
    let entryPrice: number;
    if (inst.kind === 'NIFTY' || inst.kind === 'BANKNIFTY') {
      const isExpiry = slot.role === 'expiry';
      const premium = isExpiry ? rng.float(80, 210) : inst.kind === 'NIFTY' ? rng.float(60, 250) : rng.float(150, 420);
      const type = rng.chance(0.5) ? 'CE' : 'PE';
      const step = inst.strikeStep!;
      const spot = drift.get(`${u}|${date}`)!;
      const atm = Math.round(spot / step) * step;
      const hi = inst.kind === 'NIFTY' ? 250 : 420;
      const otm = Math.round(clamp((hi - premium) / (inst.kind === 'NIFTY' ? 38 : 60), 0, 6));
      const strike = type === 'CE' ? atm + otm * step : atm - otm * step;
      entryPrice = roundTick(premium);
      if (isExpiry) symbol = niftySymbol(date, strike, type);
      else if (inst.kind === 'NIFTY') symbol = niftySymbol(nextTuesday(date), strike, type);
      else symbol = monthlySymbol(u, date, strike, type);
    } else {
      symbol = symbolFor(inst, date, rng);
      entryPrice = roundTick(drift.get(`${u}|${date}`)! + rng.normal(0, inst.kind === 'FUT' ? 4 : inst.price * 0.002));
    }
    const dir = slot.dir;
    let exitPrice = roundTick(entryPrice + (dir * gross) / qty);
    if (exitPrice < 1) exitPrice = 1;
    const entrySec = entryMin * 60 + rng.int(0, 59);
    const exitSec = (entryMin + slot.hold) * 60 + rng.int(0, 59);
    const canSplit = inst.qty / inst.lot >= 2;
    const entryFills = canSplit && slot.role !== 'one-off' && rng.chance(0.15) ? 2 : 1;
    const exitFills = canSplit && rng.chance(0.15) ? (inst.qty / inst.lot >= 3 && rng.chance(0.4) ? 3 : 2) : 1;
    const legs = makeLegs({ dir, qty, lot: inst.lot, entryPrice, exitPrice, entrySec, exitSec, entryFills, exitFills, rng });
    const tradeRows = legsToRows(symbol, inst, date, legs, ids, rng, 0.08);
    rows.push(...tradeRows);
    built.push(summarise(slot.role, symbol, u, date, legs, tradeRows, dir, qty));
  }

  // --- the open position: bought 15:20 on the last day, never closed -----
  const lastDay = days[days.length - 1];
  const openInst = INSTRUMENTS.HDFCBANK;
  const openPrice = roundTick(drift.get(`HDFCBANK|${lastDay}`)! + 1.4);
  const openRow: FillRow = {
    symbol: 'HDFCBANK',
    isin: openInst.isin!,
    tradeDate: lastDay,
    segment: 'EQ',
    side: 'buy',
    qty: openInst.qty,
    price: openPrice,
    tradeId: ids.nextTrade(),
    orderId: ids.nextOrder(),
    time: stamp(lastDay, 15 * 60 + 20, rng.int(3, 48)),
  };
  rows.push(openRow);

  rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  // ids increase with time, like a real tradebook (fills of one order keep one order id)
  const idRng = new Rng(hashSeed('tradelens-sample-ids', attempt));
  const orderMap = new Map<string, string>();
  let tradeNo = 10_482_000;
  let orderNo = 2_609_010_000_000;
  for (const r of rows) {
    tradeNo += idRng.int(3, 40);
    r.tradeId = String(tradeNo);
    if (!orderMap.has(r.orderId)) {
      orderNo += idRng.int(5, 400);
      orderMap.set(r.orderId, String(orderNo));
    }
    r.orderId = orderMap.get(r.orderId)!;
  }
  return { rows, trades: built, open: { symbol: openRow.symbol, qty: openRow.qty, time: openRow.time } };
}

function summarise(
  role: Role,
  symbol: string,
  underlying: string,
  date: string,
  legs: Leg[],
  rows: FillRow[],
  dir: 1 | -1,
  qty: number,
): BuiltTrade {
  const times = legs.map((l) => l.sec);
  const entrySec = Math.min(...times);
  const exitSec = Math.max(...times);
  const kind = parseSymbol(symbol).kind;
  const seen = new Set<string>();
  let fees = 0;
  for (const r of rows) {
    const first = !seen.has(r.orderId);
    seen.add(r.orderId);
    fees += estimateCharges({ kind, side: r.side === 'buy' ? 'BUY' : 'SELL', qty: r.qty, price: r.price, chargeBrokerage: first });
  }
  const iso = (s: number) => stamp(date, Math.floor(s / 60), s % 60);
  return {
    role,
    symbol,
    underlying,
    date,
    entryTime: iso(entrySec),
    exitTime: iso(exitSec),
    entrySec,
    exitSec,
    gross: round2(rows.reduce((a, r) => a + (r.side === 'sell' ? 1 : -1) * r.qty * r.price, 0)),
    fees: round2(fees),
    qty,
    turnover: legs.reduce((s, l) => s + l.qty * l.price, 0),
    dir,
    fills: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Validation: every property the brief asks for, computed from the fills
// ---------------------------------------------------------------------------

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;
const variance = (xs: number[]) => {
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
};
/** Welch's t for mean(a) - mean(b): negative means a is worse. */
function welch(a: number[], b: number[]): number {
  return (mean(a) - mean(b)) / Math.sqrt(variance(a) / a.length + variance(b) / b.length);
}

const WINDOW_EDGES = [
  ['opening', 555, 585],
  ['morning', 585, 690],
  ['midday', 690, 810],
  ['afternoon', 810, 885],
  ['closing', 885, 960],
] as const;

export interface Stats {
  roundTrips: number;
  fills: number;
  gross: number;
  net: number;
  fees: number;
  plantedGross: Record<string, number>;
  ordinaryGross: number;
  holdingExcess: number;
  longLosers: number;
  windowNet: Record<string, number>;
  windowT: Record<string, number>;
  underlyingT: Record<string, number>;
  windowCount: Record<string, number>;
  underlyingNet: Record<string, number>;
  underlyingTurnover: Record<string, number>;
  maxPerDay: number;
}

function validate(b: Built): Stats {
  const { trades, rows } = b;
  const net = (t: BuiltTrade) => t.gross - t.fees;
  const { episodes, open } = episodesFromRows(rows);
  check(episodes.length === trades.length, `episode count ${episodes.length} != trades ${trades.length}`);
  check(open.length === 1 && open[0].symbol === b.open.symbol, 'expected exactly one open position');
  check(Math.abs(sum(episodes.map((e) => e.gross)) - sum(trades.map((t) => t.gross))) < 0.5, 'episode gross mismatch');
  check(trades.length >= 150 && trades.length <= 180, `round trips ${trades.length} outside 150-180`);
  check(rows.length >= 350 && rows.length <= 450, `fills ${rows.length} outside 350-450`);

  // net sign must equal gross sign with room to spare, so classification is stable under fee estimates
  for (const t of trades) {
    check(t.gross * net(t) > 0 && Math.abs(t.gross) >= 3.5 * t.fees, `${t.symbol} ${t.entryTime}: |gross| ${t.gross} too small vs fees ${t.fees}`);
  }

  // per-day shape
  const byDay = new Map<string, BuiltTrade[]>();
  for (const t of trades) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t].sort((x, y) => x.entrySec - y.entrySec));
  const counts = [...byDay.values()].map((d) => d.length);
  const maxPerDay = Math.max(...counts);
  check(maxPerDay <= 8, 'more than 8 trades in a day');
  check(median(counts) === maxPerDay, 'median trades per day must equal the maximum (no overtrading)');
  check(!byDay.has('2026-09-14'), 'traded on the holiday');
  let streakMax = 0;
  for (const day of byDay.values()) {
    for (const t of day) {
      let run = 0;
      for (const p of day.filter((q) => q !== t && q.exitSec <= t.entrySec).sort((x, y) => y.exitSec - x.exitSec)) {
        if (net(p) >= 0) break;
        run++;
      }
      streakMax = Math.max(streakMax, run);
    }
  }
  check(streakMax <= 2, `a trade followed ${streakMax} straight losers`);

  // quick re-entries: only the planted ones may start within 15 min of a same-underlying loss
  const reentryHits = new Set<BuiltTrade>();
  for (const day of byDay.values()) {
    for (const t of day) {
      const hit = day.some((p) => {
        if (p === t || p.underlying !== t.underlying || net(p) >= 0) return false;
        const gap = (t.entrySec - p.exitSec) / 60;
        return gap > 0 && gap <= 15;
      });
      if (hit) reentryHits.add(t);
    }
  }
  const plantedRe = trades.filter((t) => t.role === 'reentry');
  check(reentryHits.size === plantedRe.length && plantedRe.every((t) => reentryHits.has(t)), `quick re-entry set is ${reentryHits.size}, expected ${plantedRe.length}`);
  for (const t of plantedRe) {
    const gap = Math.min(
      ...(byDay.get(t.date) ?? [])
        .filter((p) => p !== t && p.underlying === t.underlying && net(p) < 0 && t.entrySec > p.exitSec)
        .map((p) => (t.entrySec - p.exitSec) / 60),
    );
    check(gap >= 1 && gap <= 11, `re-entry gap ${gap}`);
  }

  // expiry-day set
  const expiryHits = trades.filter((t) => {
    const info = parseSymbol(t.symbol);
    return info.kind === 'OPTION' && info.expiry === t.date;
  });
  const plantedEx = trades.filter((t) => t.role === 'expiry');
  check(expiryHits.length === plantedEx.length && plantedEx.every((t) => expiryHits.includes(t)), 'expiry-day set mismatch');

  const g = (ts: BuiltTrade[]) => round2(sum(ts.map((t) => t.gross)));
  const plantedGross = {
    'expiry-day': g(plantedEx),
    'quick-reentry': g(plantedRe),
  } as Record<string, number>;
  check(Math.abs(plantedGross['expiry-day'] - TARGET_EXPIRY) < 700, `expiry gross ${plantedGross['expiry-day']}`);
  check(Math.abs(plantedGross['quick-reentry'] - TARGET_REENTRY) < 700, `re-entry gross ${plantedGross['quick-reentry']}`);
  check(plantedEx.filter((t) => t.gross > 0).length === EXPIRY_WINS, 'expiry win count');
  check(plantedRe.filter((t) => t.gross > 0).length === REENTRY_WINS, 're-entry win count');

  const planted = new Set<BuiltTrade>([...plantedEx, ...plantedRe]);
  const ordinary = trades.filter((t) => !planted.has(t));
  const ordinaryGross = g(ordinary);
  check(ordinaryGross >= 15_000 && ordinaryGross <= 26_000, `ordinary gross ${ordinaryGross}`);

  // holding losers, computed the way a reviewer would: longer-than-2x-winner-median losers vs the average quick loser
  const winners = trades.filter((t) => net(t) > 0);
  const losers = trades.filter((t) => net(t) < 0);
  const hold = (t: BuiltTrade) => (t.exitSec - t.entrySec) / 60;
  const medW = median(winners.map(hold));
  const medL = median(losers.map(hold));
  const limit = 2 * medW;
  const longL = losers.filter((t) => hold(t) > limit);
  const quickL = losers.filter((t) => hold(t) <= limit);
  const baseline = sum(quickL.map(net)) / quickL.length;
  const holdingExcess = round2(sum(longL.map((t) => Math.max(0, baseline - net(t)))));
  check(medL / medW >= 2.2, `median loser hold ${medL} vs winner ${medW}`);
  if (process.env.DEBUG_SAMPLE) console.error('HL excess', holdingExcess, 'baseline', Math.round(baseline), 'quick', quickL.length, 'long', longL.length, 'medW', medW);
  check(holdingExcess >= 8_000 && holdingExcess <= 12_500, `holding-losers excess ${holdingExcess}`);
  plantedGross['holding-losers'] = g(longL);

  // decoys
  const windowNet: Record<string, number> = {};
  const windowCount: Record<string, number> = {};
  for (const [name, a, z] of WINDOW_EDGES) {
    const ts = trades.filter((t) => {
      const m = Math.floor(t.entrySec / 60);
      return m >= a && m < z;
    });
    windowNet[name] = round2(sum(ts.map(net)));
    windowCount[name] = ts.length;
  }
  check(windowNet.opening > 15_000 && windowCount.opening >= 25, `opening window not busy/profitable: ${windowCount.opening} trades, ${windowNet.opening}`);
  const opening = trades.filter((t) => Math.floor(t.entrySec / 60) < 585);
  check(opening.every((t) => t.role === 'open-win'), 'a planted or loss trade slipped into the opening window');

  // no time-of-day window may look significantly bad by chance (the planted losers have to be spread evenly)
  const windowT: Record<string, number> = {};
  for (const [name, a, z] of WINDOW_EDGES) {
    const inside = (t: BuiltTrade) => {
      const m = Math.floor(t.entrySec / 60);
      return m >= a && m < z;
    };
    windowT[name] = round2(welch(trades.filter(inside).map(net), trades.filter((t) => !inside(t)).map(net)));
    if (process.env.DEBUG_SAMPLE) {
      const roles: Record<string, number> = {};
      for (const t of trades.filter(inside)) roles[t.role] = (roles[t.role] ?? 0) + 1;
      console.error('WIN', name, windowT[name], JSON.stringify(roles), Math.round(sum(trades.filter(inside).map(net))));
    }
    if (name !== 'opening') check(windowT[name] > -2.0, `window ${name} looks bad by chance (t=${windowT[name]})`);
    if (name !== 'opening') check(windowCount[name] >= (name === 'closing' ? 12 : 22) && windowCount[name] <= 50, `window ${name} has ${windowCount[name]} trades`);
  }
  const underlyingT: Record<string, number> = {};
  for (const u of Object.keys(INSTRUMENTS)) {
    const mine = trades.filter((t) => t.underlying === u);
    underlyingT[u] = round2(welch(mine.map(net), trades.filter((t) => t.underlying !== u).map(net)));
    // NIFTY carries the expiry-day losses by design, but must not look worse than that habit alone
    check(underlyingT[u] > (u === 'NIFTY' ? -1.9 : -1.5), `${u} looks like a leak by chance (t=${underlyingT[u]})`);
  }
  check(-sum(trades.filter((t) => t.underlying === 'NIFTY').map(net)) < 0.92 * -sum(plantedEx.map(net)), 'NIFTY bleed would outrank the expiry-day habit');

  const underlyingNet: Record<string, number> = {};
  const underlyingTurnover: Record<string, number> = {};
  for (const t of trades) {
    underlyingNet[t.underlying] = round2((underlyingNet[t.underlying] ?? 0) + net(t));
    underlyingTurnover[t.underlying] = round2((underlyingTurnover[t.underlying] ?? 0) + t.turnover);
  }
  const topTurnover = Object.entries(underlyingTurnover).sort((a, b) => b[1] - a[1])[0][0];
  check(topTurnover === 'RELIANCE', `most turnover is ${topTurnover}, expected RELIANCE`);
  check(underlyingNet.RELIANCE > 2_000, `RELIANCE net ${underlyingNet.RELIANCE}`);
  const bk = trades.filter((t) => t.role === 'one-off');
  check(bk.length === 1 && bk[0].underlying === 'BANKNIFTY' && Math.abs(bk[0].gross - ONE_OFF_LOSS) < 150, 'one-off loss');

  // constant size per underlying (no size-after-loss)
  const qtys = new Map<string, Set<number>>();
  for (const t of trades) qtys.set(t.underlying, (qtys.get(t.underlying) ?? new Set()).add(t.qty));
  check([...qtys.values()].every((s) => s.size === 1), 'quantity varies within an underlying');

  const shorts = trades.filter((t) => t.dir === -1).length;
  check(shorts >= 3, 'need at least 3 short-first trades');
  const multiEntry = trades.filter((t) => t.fills >= 3).length;
  check(multiEntry >= 10, 'too few multi-fill trades');
  const orderCounts = new Map<string, number>();
  for (const r of rows) orderCounts.set(r.orderId, (orderCounts.get(r.orderId) ?? 0) + 1);
  check([...orderCounts.values()].some((n) => n > 1), 'no order has more than one fill');

  return {
    roundTrips: trades.length,
    fills: rows.length,
    gross: g(trades),
    net: round2(sum(trades.map(net))),
    fees: round2(sum(trades.map((t) => t.fees))),
    plantedGross,
    ordinaryGross,
    holdingExcess,
    longLosers: longL.length,
    windowNet,
    windowT,
    underlyingT,
    windowCount,
    underlyingNet,
    underlyingTurnover,
    maxPerDay,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function answerKey(b: Built, stats: Stats) {
  const list = (ts: BuiltTrade[]) =>
    [...ts].sort((a, b) => (a.entryTime < b.entryTime ? -1 : 1)).map((t) => ({ symbol: t.symbol, entryTime: t.entryTime }));
  const hold = (t: BuiltTrade) => (t.exitSec - t.entrySec) / 60;
  const net = (t: BuiltTrade) => t.gross - t.fees;
  const winners = b.trades.filter((t) => net(t) > 0);
  const limit = 2 * median(winners.map(hold));
  const longLosers = b.trades.filter((t) => net(t) < 0 && hold(t) > limit);
  const ex = b.trades.filter((t) => t.role === 'expiry');
  const re = b.trades.filter((t) => t.role === 'reentry');
  return {
    note: 'Synthetic data. Computed from the generated fills only (gross P&L = sum of sell value minus sum of buy value, per flat-to-flat round trip); no engine code was used.',
    totals: { roundTrips: stats.roundTrips, fills: stats.fills, grossPnl: stats.gross },
    openPosition: { symbol: b.open.symbol, qty: b.open.qty },
    planted: [
      {
        key: 'expiry-day',
        expectedRank: 1,
        description: 'Buying the NIFTY weekly option on its own expiry day, every Tuesday.',
        trades: list(ex),
        grossPnl: stats.plantedGross['expiry-day'],
      },
      {
        key: 'quick-reentry',
        expectedRank: 2,
        description: 'Re-entering the same instrument, same size, 2-10 minutes after a losing trade.',
        trades: list(re),
        grossPnl: stats.plantedGross['quick-reentry'],
      },
      {
        key: 'holding-losers',
        expectedRank: 3,
        description: 'Losers held 45-105 minutes (winners 6-20) and about 2.6x bigger than the quick losers. Includes the one-off BANKNIFTY loss, which is also a long-held loser.',
        trades: list(longLosers),
        grossPnl: stats.plantedGross['holding-losers'],
        excessLossEstimate: stats.holdingExcess,
      },
    ],
    decoys: [
      { key: 'time-window:opening', note: 'The opening half hour is the busiest window and clearly profitable.' },
      { key: 'instrument-bleed:RELIANCE', note: 'RELIANCE futures have the most turnover and are net profitable.' },
      { key: 'instrument-bleed:BANKNIFTY', note: 'One large BANKNIFTY loss (about -6,000) is a one-off; BANKNIFTY overall is not a repeated leak.' },
      { key: 'size-after-loss', note: 'Quantity is constant per underlying, so there is no sizing up after losses.' },
      { key: 'overtrading', note: 'No day has more trades than the typical day (max 8, median 8).' },
      { key: 'loss-streak', note: 'No day has three losing trades in a row.' },
      { key: 'fee-churn', note: 'Every trade moves at least 3.5x its estimated charges.' },
    ],
  };
}

function writeTradebookXlsx(rows: FillRow[], file: string): void {
  const header = FILL_HEADER.split(',');
  const aoa: (string | number)[][] = [header];
  for (const r of rows) {
    aoa.push([
      r.symbol,
      r.isin,
      r.tradeDate,
      'NSE',
      r.segment,
      r.segment === 'EQ' ? 'EQ' : '',
      r.side,
      'false',
      r.qty,
      r.price,
      r.tradeId,
      r.orderId,
      r.time,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'tradebook');
  wb.Props = { Title: 'Synthetic tradebook', Author: 'TradeLens sample generator', CreatedDate: new Date(Date.UTC(2026, 9, 1)) };
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  fs.writeFileSync(file, out);
}

const TEMPLATE_TRADEBOOK = [
  FILL_HEADER,
  'NIFTY2690825000CE,,2026-09-02,NSE,FO,,buy,false,65,142.35,90000001,2609020000001,2026-09-02T10:12:41',
  'NIFTY2690825000CE,,2026-09-02,NSE,FO,,sell,false,65,158.60,90000002,2609020000002,2026-09-02T10:31:07',
  'HDFCBANK,INE040A01034,2026-09-02,NSE,EQ,EQ,buy,false,100,1002.40,90000003,2609020000003,2026-09-02T11:05:19',
  'HDFCBANK,INE040A01034,2026-09-02,NSE,EQ,EQ,sell,false,100,1006.15,90000004,2609020000004,2026-09-02T11:24:52',
  '',
].join('\n');

const TEMPLATE_CLOSED = [
  'id,symbol,entry_time,exit_time,pnl,fees,quantity',
  't1,NIFTY2690825000CE,2026-09-02T10:12:00,2026-09-02T10:31:00,1056.25,64.20,65',
  't2,HDFCBANK,2026-09-02T11:05:00,2026-09-02T11:24:00,375.00,58.10,100',
  't3,RELIANCE26SEPFUT,2026-09-03T13:40:00,2026-09-03T14:02:00,-1250.00,212.40,500',
  '',
].join('\n');

const money = (n: number) => `${n < 0 ? '-' : '+'}Rs ${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

const readme = (st: Stats) => `# TradeLens sample data

Everything in this folder is **synthetic and fictional**. The "trader" does not exist, the prices are
made up (they are only shaped like NSE data), and nothing here is a record of anyone's real orders.

| File | What it is |
| --- | --- |
| \`sept-2026-tradebook.csv\` | A month (1-30 Sep 2026) of executions in Zerodha-Console tradebook layout, one row per fill. No charges column, like the real thing, so TradeLens estimates charges. |
| \`sept-2026-tradebook.xlsx\` | The same rows as an Excel workbook (sheet \`tradebook\`). |
| \`sept-2026-tradebook.answer-key.json\` | What was planted and what must not be flagged. Computed from the fills, not from the analysis engine. |
| \`template-tradebook.csv\` | Header plus two example round trips, for people preparing their own file. |
| \`template-closed-trades.csv\` | The simpler "one row per closed trade" layout (\`id,symbol,entry_time,exit_time,pnl,fees,quantity\`). |
| \`tradelens-example.xlsx\` | The small 60-trade example from the brief (title row, blank row, then the table). |

Regenerate the first five with \`npm run samples\`. The generator is seeded, so the files are byte-for-byte
identical every time.

## What is in the month

${st.roundTrips} round trips and ${st.fills} fills across NIFTY weekly options (expiring every Tuesday: 1, 8, 15, 22 and
29 Sep), BANKNIFTY monthly options, RELIANCE futures, and HDFCBANK / INFY intraday. 14 Sep is treated as a
market holiday. Some trades scale in (two buys), some exit in parts (two or three sells), five are short-first,
and the month ends with one HDFCBANK position bought at 15:20 on 30 Sep and never closed (TradeLens should
set it aside and say so). Quantity is constant per underlying.

## The three planted habits

The expiry-day and re-entry trades are disjoint from each other and from everything ordinary; the
holding-losers set is the long-held ordinary losers (including the loser that each re-entry follows).

1. **Expiry-day option buying** (${money(st.plantedGross['expiry-day'])} gross). Every Tuesday the trader buys five of the NIFTY weekly
   option that expires that same day (25 trades). One in five wins.
2. **Quick re-entry after a loss** (${money(st.plantedGross['quick-reentry'])} gross). On 12 non-Tuesdays, a loss is followed 2-10
   minutes later by a fresh trade in the same instrument at the same size. About a quarter of those win.
3. **Holding losers** (about Rs ${(Math.round(st.holdingExcess / 100) * 100).toLocaleString('en-IN')} of extra loss compared with the quicker losses, ${st.longLosers} trades). Ordinary winners are
   held 6-20 minutes; ordinary losers 45-105 minutes, and about 2.5x the size of the few quick ordinary losers.

Everything else is ordinary trading that makes about ${money(Math.round(st.ordinaryGross / 100) * 100)} gross, so the headline of
the review is: these habits turned a profitable month into a loss (${money(st.gross)} gross, ${money(st.net)} after estimated charges).

## The decoys (a good review must NOT flag these)

* **Opening half hour (9:15-9:45)** is the busiest window and clearly profitable.
* **RELIANCE futures** have the highest turnover and are net profitable.
* **One big BANKNIFTY loss** (about -Rs 6,000) is a one-off, not a leaking instrument.
* **Position size** is constant per underlying, so there is no "sizing up after a loss".
* **Overtrading and loss streaks**: no day has more than 8 trades (the typical day), and no day has three losers
  in a row outside the planted sets.

The \`decoys\` list in the answer key names the habit keys that must not appear.
`;

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let built: Built | null = null;
  let stats: Stats | null = null;
  const reasons = new Map<string, number>();
  for (let attempt = 0; attempt < 400 && !built; attempt++) {
    try {
      const b = buildOnce(attempt);
      stats = validate(b);
      built = b;
      console.log(`accepted attempt ${attempt}`);
    } catch (e) {
      if (!(e instanceof Retry)) throw e;
      const key = e.message.replace(/[-\d.]+/g, '#');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  if (!built || !stats) {
    console.error('Could not build a valid dataset. Rejection reasons:');
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.error(`  ${n}x ${k}`);
    process.exit(1);
  }

  fs.writeFileSync(path.join(OUT_DIR, `${BASE_NAME}.csv`), fillsToCsv(built.rows));
  writeTradebookXlsx(built.rows, path.join(OUT_DIR, `${BASE_NAME}.xlsx`));
  fs.writeFileSync(path.join(OUT_DIR, `${BASE_NAME}.answer-key.json`), JSON.stringify(answerKey(built, stats), null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'template-tradebook.csv'), TEMPLATE_TRADEBOOK);
  fs.writeFileSync(path.join(OUT_DIR, 'template-closed-trades.csv'), TEMPLATE_CLOSED);
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme(stats));

  console.log(`round trips ${stats.roundTrips}, fills ${stats.fills}, max trades/day ${stats.maxPerDay}`);
  console.log(`gross ${stats.gross}, fees (estimated) ${stats.fees}, net ${stats.net}`);
  console.log('planted gross', stats.plantedGross, 'holding-losers excess', stats.holdingExcess, 'ordinary gross', stats.ordinaryGross);
  console.log('window net', stats.windowNet, 'window trades', stats.windowCount);
  console.log('window t', stats.windowT, 'underlying t', stats.underlyingT);
  console.log('underlying net', stats.underlyingNet);
  console.log('underlying turnover (Rs lakh)', Object.fromEntries(Object.entries(stats.underlyingTurnover).map(([k, v]) => [k, Math.round(v / 1e5)])));
}

main();
