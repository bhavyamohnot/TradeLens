// Shared plumbing for the sample-data script and the eval generators:
// seeded PRNG, calendar helpers, NSE symbol builders, Zerodha-style fill
// decomposition and CSV writers. Nothing here imports the analysis engine, so
// the fixtures and answer keys stay independent of the code under test.

// ---------------------------------------------------------------------------
// Seeded randomness (no Math.random anywhere in the fixture code)
// ---------------------------------------------------------------------------

export function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** mulberry32: uniform in [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  float(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** integer in [a, b] inclusive */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /** Box-Muller */
  normal(mu = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** child generator with its own stream */
  fork(label: string | number): Rng {
    return new Rng(hashSeed(this.s, label));
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const pad2 = (n: number) => String(n).padStart(2, '0');
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function ymd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
/** 0 = Sunday ... 6 = Saturday */
export const dow = (s: string) => parseYmd(s).getUTCDay();
export const isTuesday = (s: string) => dow(s) === 2;

export function weekdaysFrom(start: string, count: number, skip: string[] = []): string[] {
  const out: string[] = [];
  let d = start;
  while (out.length < count) {
    const w = dow(d);
    if (w !== 0 && w !== 6 && !skip.includes(d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}
export function weekdaysInMonth(year: number, month: number, skip: string[] = []): string[] {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const s = `${year}-${pad2(month)}-${pad2(d)}`;
    if (parseYmd(s).getUTCMonth() !== month - 1) break;
    if (dow(s) !== 0 && dow(s) !== 6 && !skip.includes(s)) out.push(s);
  }
  return out;
}

/** Last Tuesday of a month (NSE monthly expiry from Sep 2025). */
export function lastTuesday(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - 2 + 7) % 7;
  last.setUTCDate(last.getUTCDate() - back);
  return ymd(last);
}
/** First Tuesday strictly after `date`. */
export function nextTuesday(date: string): string {
  let d = addDays(date, 1);
  while (dow(d) !== 2) d = addDays(d, 1);
  return d;
}

export const minToClock = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
export const stamp = (date: string, minuteOfDay: number, seconds = 0) =>
  `${date}T${pad2(Math.floor(minuteOfDay / 60))}:${pad2(Math.floor(minuteOfDay) % 60)}:${pad2(seconds)}`;

// ---------------------------------------------------------------------------
// Instruments and symbols
// ---------------------------------------------------------------------------

export type Kind = 'NIFTY' | 'BANKNIFTY' | 'FUT' | 'EQ';

export interface Instrument {
  underlying: string;
  kind: Kind;
  lot: number;
  /** constant trade size for this underlying */
  qty: number;
  /** typical price for the instrument (option premium or share/futures price) */
  price: number;
  strikeStep?: number;
  spot?: number;
  isin?: string;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const roundTick = (p: number, tick = 0.05) => round2(Math.round(p / tick) * tick);

const yy = (year: number) => String(year % 100).padStart(2, '0');

function weeklyMonthCode(month: number): string {
  return month <= 9 ? String(month) : month === 10 ? 'O' : month === 11 ? 'N' : 'D';
}

/** NIFTY option for a given expiry date. Monthly (last-Tuesday) contracts use the SEP style, others the 26908 style. */
export function niftySymbol(expiry: string, strike: number, type: 'CE' | 'PE'): string {
  const [y, m, d] = expiry.split('-').map(Number);
  const monthly = expiry === lastTuesday(y, m);
  return monthly
    ? `NIFTY${yy(y)}${MON[m - 1]}${strike}${type}`
    : `NIFTY${yy(y)}${weeklyMonthCode(m)}${pad2(d)}${strike}${type}`;
}

/** Monthly contract that expires strictly after `date` (so never an expiry-day trade). */
export function monthlyExpiryAfter(date: string): { year: number; month: number; expiry: string } {
  let [y, m] = date.split('-').map(Number);
  for (let i = 0; i < 3; i++) {
    const e = lastTuesday(y, m);
    if (e > date) return { year: y, month: m, expiry: e };
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  throw new Error('unreachable');
}

export function monthlySymbol(underlying: string, date: string, strike: number | null, type: 'CE' | 'PE' | null): string {
  const { year, month } = monthlyExpiryAfter(date);
  return strike === null
    ? `${underlying}${yy(year)}${MON[month - 1]}FUT`
    : `${underlying}${yy(year)}${MON[month - 1]}${strike}${type}`;
}

export const NIFTY: Instrument = { underlying: 'NIFTY', kind: 'NIFTY', lot: 65, qty: 195, price: 120, strikeStep: 50, spot: 25000 };
export const BANKNIFTY: Instrument = { underlying: 'BANKNIFTY', kind: 'BANKNIFTY', lot: 30, qty: 90, price: 300, strikeStep: 100, spot: 55000 };
export const RELIANCE: Instrument = { underlying: 'RELIANCE', kind: 'FUT', lot: 500, qty: 500, price: 1400 };
export const HDFCBANK: Instrument = { underlying: 'HDFCBANK', kind: 'EQ', lot: 10, qty: 150, price: 1000, isin: 'INE040A01034' };
export const INFY: Instrument = { underlying: 'INFY', kind: 'EQ', lot: 10, qty: 150, price: 1500, isin: 'INE009A01021' };
export const TCS: Instrument = { underlying: 'TCS', kind: 'EQ', lot: 10, qty: 100, price: 3300, isin: 'INE467B01029' };

/** Symbol for a trade in `inst` on `date`: options use a contract that has NOT expired yet. */
export function symbolFor(inst: Instrument, date: string, rng: Rng, optionType?: 'CE' | 'PE'): string {
  const type = optionType ?? (rng.chance(0.5) ? 'CE' : 'PE');
  switch (inst.kind) {
    case 'NIFTY': {
      const step = inst.strikeStep!;
      const strike = Math.round((inst.spot! + rng.int(-4, 4) * step) / step) * step;
      return niftySymbol(nextTuesday(date), strike, type);
    }
    case 'BANKNIFTY': {
      const step = inst.strikeStep!;
      const strike = Math.round((inst.spot! + rng.int(-4, 4) * step) / step) * step;
      return monthlySymbol(inst.underlying, date, strike, type);
    }
    case 'FUT':
      return monthlySymbol(inst.underlying, date, null, null);
    case 'EQ':
      return inst.underlying;
  }
}

export const segmentOf = (inst: Instrument): 'FO' | 'EQ' => (inst.kind === 'EQ' ? 'EQ' : 'FO');

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export interface FillRow {
  symbol: string;
  isin: string;
  tradeDate: string;
  segment: 'FO' | 'EQ';
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  tradeId: string;
  orderId: string;
  time: string; // YYYY-MM-DDTHH:mm:ss
}

export const FILL_HEADER =
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time';

export function fillsToCsv(rows: FillRow[], eol = '\n'): string {
  const lines = [FILL_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.symbol,
        r.isin,
        r.tradeDate,
        'NSE',
        r.segment,
        r.segment === 'EQ' ? 'EQ' : '',
        r.side,
        'false',
        r.qty,
        r.price.toFixed(2),
        r.tradeId,
        r.orderId,
        r.time,
      ].join(','),
    );
  }
  return lines.join(eol) + eol;
}

/** One round trip described by its fills, the unit both generators work in. */
export interface Leg {
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  /** absolute seconds since midnight */
  sec: number;
  /** legs with the same group share an order id */
  group: number;
}

/** Split `qty` into `n` lot-aligned parts (falls back to fewer parts when the position is too small). */
export function splitQty(qty: number, lot: number, n: number): number[] {
  const units = Math.round(qty / lot);
  const parts = Math.min(n, units);
  if (parts <= 1) return [qty];
  const out: number[] = [];
  let left = units;
  for (let i = 0; i < parts; i++) {
    const take = i === parts - 1 ? left : Math.max(1, Math.round(units / parts));
    out.push(take * lot);
    left -= take;
  }
  return out;
}

/** Gross P&L from legs: Σ sell value − Σ buy value. */
export function legsGross(legs: Leg[]): number {
  return round2(legs.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.qty * l.price, 0));
}

/**
 * Build the legs of one round trip. The average entry/exit price is
 * `entryPrice`/`exitPrice`; multi-fill entries and exits spread around them.
 */
export function makeLegs(opts: {
  dir: 1 | -1; // 1 long (buy then sell), -1 short (sell then buy)
  qty: number;
  lot: number;
  entryPrice: number;
  exitPrice: number;
  entrySec: number;
  exitSec: number;
  entryFills: number;
  exitFills: number;
  tick?: number;
  rng: Rng;
}): Leg[] {
  const { dir, qty, lot, rng } = opts;
  const tick = opts.tick ?? 0.05;
  const open: 'buy' | 'sell' = dir === 1 ? 'buy' : 'sell';
  const close: 'buy' | 'sell' = dir === 1 ? 'sell' : 'buy';
  const legs: Leg[] = [];
  let group = 0;

  const spread = (parts: number[], avg: number) => {
    // prices spread by a few ticks around avg, weighted so the average stays put
    if (parts.length === 1) return [roundTick(avg, tick)];
    const d = tick * rng.int(2, 6);
    const total = parts.reduce((a, b) => a + b, 0);
    const offsets = parts.map((_, i) => (i === 0 ? -d : d * ((parts[0] / (total - parts[0])) || 1)));
    return offsets.map((o) => roundTick(avg + o, tick));
  };

  const entryParts = splitQty(qty, lot, opts.entryFills);
  const entryPrices = spread(entryParts, opts.entryPrice);
  const span = Math.max(opts.exitSec - opts.entrySec, 120);
  entryParts.forEach((q, i) => {
    legs.push({
      side: open,
      qty: q,
      price: entryPrices[i],
      sec: i === 0 ? opts.entrySec : opts.entrySec + Math.min(rng.int(60, 240), Math.floor(span / 3)) * i,
      group: group++,
    });
  });
  const lastEntrySec = Math.max(...legs.map((l) => l.sec));
  const exitParts = splitQty(qty, lot, opts.exitFills);
  const exitPrices = spread(exitParts, opts.exitPrice);
  exitParts.forEach((q, i) => {
    const fromEnd = exitParts.length - 1 - i;
    legs.push({
      side: close,
      qty: q,
      price: exitPrices[i],
      sec: Math.max(opts.exitSec - fromEnd * rng.int(60, 180), lastEntrySec + 1),
      group: group++,
    });
  });
  return legs;
}

export function legsToRows(
  symbol: string,
  inst: Instrument,
  date: string,
  legs: Leg[],
  ids: { nextTrade: () => string; nextOrder: () => string },
  rng: Rng,
  splitProb = 0,
): FillRow[] {
  const rows: FillRow[] = [];
  const orderOf = new Map<number, string>();
  for (const l of legs) {
    if (!orderOf.has(l.group)) orderOf.set(l.group, ids.nextOrder());
    const sec = Math.min(l.sec, 15 * 3600 + 29 * 60 + 59);
    const base: Omit<FillRow, 'qty' | 'price' | 'tradeId' | 'time'> = {
      symbol,
      isin: inst.isin ?? '',
      tradeDate: date,
      segment: segmentOf(inst),
      side: l.side,
      orderId: orderOf.get(l.group)!,
    };
    const time = (s: number) => stamp(date, Math.floor(s / 60), s % 60);
    const parts = splitQty(l.qty, inst.lot, rng.chance(splitProb) ? 2 : 1);
    parts.forEach((q, i) => {
      rows.push({
        ...base,
        qty: q,
        price: i === 0 ? l.price : roundTick(l.price + (rng.chance(0.5) ? 0.05 : 0)),
        tradeId: ids.nextTrade(),
        time: time(sec + i),
      });
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Independent round-trip reconstruction (used for answer keys and checks)
// ---------------------------------------------------------------------------

export interface Episode {
  symbol: string;
  entryTime: string;
  exitTime: string;
  gross: number;
  rows: number;
}

/** Flat-to-flat episodes per symbol from fill rows; a fill crossing zero closes one and opens the next. */
export function episodesFromRows(rows: FillRow[]): { episodes: Episode[]; open: { symbol: string; qty: number }[] } {
  const sorted = [...rows].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  type Open = { pos: number; value: number; entry: string; rows: number };
  const open = new Map<string, Open>();
  const episodes: Episode[] = [];
  for (const r of sorted) {
    const signed = r.side === 'buy' ? r.qty : -r.qty;
    let ep = open.get(r.symbol);
    if (!ep) {
      ep = { pos: 0, value: 0, entry: r.time, rows: 0 };
      open.set(r.symbol, ep);
    }
    const crosses = ep.pos !== 0 && Math.sign(signed) !== Math.sign(ep.pos) && Math.abs(signed) > Math.abs(ep.pos);
    if (!crosses) {
      ep.pos += signed;
      ep.value += -signed * r.price;
      ep.rows++;
      if (ep.pos === 0) {
        episodes.push({ symbol: r.symbol, entryTime: ep.entry, exitTime: r.time, gross: round2(ep.value), rows: ep.rows });
        open.delete(r.symbol);
      }
    } else {
      const closing = -ep.pos;
      ep.value += -closing * r.price;
      episodes.push({ symbol: r.symbol, entryTime: ep.entry, exitTime: r.time, gross: round2(ep.value), rows: ep.rows + 1 });
      const rest = signed - closing;
      open.set(r.symbol, { pos: rest, value: -rest * r.price, entry: r.time, rows: 1 });
    }
  }
  return {
    episodes,
    open: [...open].filter(([, e]) => e.pos !== 0).map(([symbol, e]) => ({ symbol, qty: e.pos })),
  };
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

export function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: (string | number)[]) => cells.map(csvCell).join(',');

// ---------------------------------------------------------------------------
// Intraday layout
// ---------------------------------------------------------------------------

export interface LayoutItem {
  /** minutes between first entry fill and last exit fill */
  hold: number;
  loss: boolean;
  /** exact gap (min) after the previous trade's exit; overrides the loss/win minimum */
  pinGap?: number;
  /** first-half-hour trade: placed before every non-opening trade */
  opening?: boolean;
}

export interface LayoutOpts {
  from?: number; // 09:15
  to?: number; // latest allowed exit
  winGap?: number;
  lossGap?: number;
  /** first minute a non-opening trade may start */
  openingEnd?: number;
}

export const MIN_0915 = 9 * 60 + 15;
export const MIN_0945 = 9 * 60 + 45;
export const MIN_1525 = 15 * 60 + 25;

/**
 * Places a day's trades one after another (never overlapping). Returns the
 * entry minute of each item, or null when they cannot fit. Spare time is
 * spread randomly, so entries land across the whole session.
 */
export function layoutDay(items: LayoutItem[], rng: Rng, opts: LayoutOpts = {}): number[] | null {
  const from = opts.from ?? MIN_0915;
  const to = opts.to ?? MIN_1525;
  const winGap = opts.winGap ?? 4;
  const lossGap = opts.lossGap ?? 26;
  const openingEnd = opts.openingEnd ?? MIN_0945 + 1;
  const n = items.length;
  if (n === 0) return [];
  const gap = (i: number) => (i === 0 ? 0 : items[i].pinGap ?? (items[i - 1].loss ? lossGap : winGap));
  const firstFree = items.findIndex((x) => !x.opening);
  const extra = new Array<number>(n + 1).fill(0); // extra[i] = slack added before item i; extra[n] = after the last
  extra[0] = rng.int(0, 4);
  const entries: number[] = [];
  const recompute = () => {
    let t = from;
    for (let i = 0; i < n; i++) {
      t += gap(i) + extra[i];
      entries[i] = t;
      t += items[i].hold;
    }
    return t;
  };
  let end = recompute();
  if (firstFree >= 0 && entries[firstFree] < openingEnd) {
    extra[firstFree] += openingEnd - entries[firstFree];
    end = recompute();
  }
  const slack = to - end;
  if (slack < 0) return null;
  const freeIdx: number[] = [];
  for (let i = Math.max(firstFree, 0); i <= n; i++) {
    if (i < n && items[i].pinGap !== undefined) continue;
    freeIdx.push(i);
  }
  if (firstFree < 0) freeIdx.push(n);
  const w = freeIdx.map(() => -Math.log(Math.max(rng.next(), 1e-9)));
  const total = w.reduce((a, b) => a + b, 0);
  let left = slack;
  freeIdx.forEach((i, k) => {
    const add = Math.floor((slack * w[k]) / total);
    extra[i] += add;
    left -= add;
  });
  extra[freeIdx[rng.int(0, freeIdx.length - 1)]] += left;
  recompute();
  return entries;
}
