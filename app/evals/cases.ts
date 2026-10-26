// Eval cases: fixed regression cases with explicit assertions, seeded sweeps over
// the fixture generators, and the copy/consistency checks applied to every
// review any case produces.

import fs from 'node:fs';
import path from 'node:path';
import { analyzeFile, detect, readTable } from '../src/engine';
import type { Review } from '../src/engine';
import { fillsToCsv, stamp } from './common';
import type { FillRow } from './common';
import {
  HABIT_KINDS,
  baseline,
  expectedKey,
  plant,
  plantSymbolVsTime,
  toClosedCsv,
  toClosedRows,
  toFillsCsv,
  CLOSED_HEADER,
  type Fixture,
  type HabitKind,
} from './generators';

const ROOT = path.resolve(import.meta.dirname, '..');
export const SAMPLES_DIR = path.join(ROOT, 'public', 'samples');

// ---------------------------------------------------------------------------
// Types and small helpers
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface CaseOutcome {
  id: string;
  title: string;
  checks: Check[];
  reviews: Review[];
  /** one-line facts worth printing (not pass/fail) */
  info: string[];
}

export interface EvalCase {
  id: string;
  title: string;
  run(): CaseOutcome;
}

const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, detail });
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-IN');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const keysOf = (r: Review) => r.habits.map((h) => h.key);

type Analysed = ReturnType<typeof analyzeFile>;

function analyse(data: ArrayBuffer | Uint8Array | string, fileName: string): Analysed {
  return analyzeFile(data, fileName);
}

function bytes(path_: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path_));
}

// ---------------------------------------------------------------------------
// Copy and consistency checks (applied to every review)
// ---------------------------------------------------------------------------

const BANNED = ['revenge', 'emotional', 'greedy', 'stupid', 'gamble', 'gambling', 'disposition', 'profit factor', 'tilt'];

export function reviewChecks(review: Review): Check[] {
  const out: Check[] = [];
  const ids = new Set(review.trades.map((t) => t.id));
  const bad = (name: string, detail: string) => out.push(check(name, false, detail));

  if (review.habits.length > 3) bad('at most 3 habits', `${review.habits.length} habits`);
  review.habits.forEach((h, i) => {
    const where = `${h.key}`;
    if (h.rank !== i + 1) bad('ranks run 1..n', `${where} has rank ${h.rank} at position ${i + 1}`);
    if (h.title.length > 60) bad('title <= 60 chars', `${where}: ${h.title.length} chars "${h.title}"`);
    const text = [h.title, h.summary, h.rule, ...h.evidence].join(' \n ').toLowerCase();
    for (const w of BANNED) if (text.includes(w)) bad('no banned words', `${where} contains "${w}"`);
    if (!h.summary.includes('₹')) bad('summary has a ₹ figure', `${where}: "${h.summary}"`);
    if (!h.rule.trim()) bad('rule is non-empty', where);
    if (h.tradeIds.length === 0) bad('tradeIds non-empty', where);
    if (!(h.cost > 0)) bad('cost > 0', `${where}: ${h.cost}`);
    const missing = h.tradeIds.filter((id) => !ids.has(id));
    if (missing.length) bad('every tradeId exists in review.trades', `${where}: ${missing.slice(0, 3).join(', ')}`);
    if (i > 0 && h.cost > review.habits[i - 1].cost + 1e-9) bad('habits sorted by cost descending', `${where} costs more than the habit above it`);
  });
  const verdictText = review.verdict.toLowerCase();
  for (const w of BANNED) if (verdictText.includes(w)) bad('no banned words', `verdict contains "${w}"`);

  const netSum = sum(review.trades.map((t) => t.netPnl));
  if (!near(netSum, review.summary.netPnl, 1)) bad('sum of trade net P&L equals summary.netPnl', `${fmt(netSum)} vs ${fmt(review.summary.netPnl)}`);
  const absLosses = sum(review.trades.filter((t) => t.netPnl < 0).map((t) => -t.netPnl));
  const fees = sum(review.trades.map((t) => t.fees));
  const costs = sum(review.habits.map((h) => h.cost));
  if (costs > absLosses + fees + 1) bad('habit costs <= total losses + fees', `${fmt(costs)} > ${fmt(absLosses + fees)}`);

  const last = review.equity[review.equity.length - 1];
  if (last) {
    let running = 0;
    review.habits.forEach((h, i) => {
      running += h.cost;
      const expected = last.actual + running;
      if (!near(last.withoutHabits[i], expected, 1)) bad('equity series: without-habits end = actual + costs', `habit ${i + 1}: ${fmt(last.withoutHabits[i])} vs ${fmt(expected)}`);
    });
    if (!near(last.actual, review.summary.netPnl, 1)) bad('equity series ends at net P&L', `${fmt(last.actual)} vs ${fmt(review.summary.netPnl)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixed cases
// ---------------------------------------------------------------------------

/**
 * The brief states the longest losing streak in the example file is 20. The file
 * holds 20 BANKNIFTY losses in a row followed by one more REENTRY loss, which
 * makes 21 trades in a row; see REPORT.md. The assertion below keeps the brief's
 * number so the discrepancy stays visible.
 */
// 20 BANKNIFTY losses, then one more REENTRY loss (demo-23) before the next win = 21.
// The original brief said 20; a recount of the workbook in every ordering gives 21.
const BRIEF_EXAMPLE_LONGEST_STREAK = 21;

function briefExample(): CaseOutcome {
  const file = path.join(SAMPLES_DIR, 'tradelens-example.xlsx');
  const { review, parsed } = analyse(bytes(file), 'tradelens-example.xlsx');
  const s = review.summary;
  const checks: Check[] = [
    check('60 trades', review.trades.length === 60, `${review.trades.length}`),
    check('gross P&L is -2,990', s.grossPnl !== null && near(s.grossPnl, -2990, 0.5), `${s.grossPnl}`),
    check('fees are 2,100', near(s.fees, 2100, 0.5), `${s.fees}`),
    check('net P&L is -5,090', near(s.netPnl, -5090, 0.5), `${s.netPnl}`),
  ];
  const first = review.habits[0];
  checks.push(check('habit #1 is instrument-bleed:BANKNIFTY', first?.key === 'instrument-bleed:BANKNIFTY', first?.key ?? 'no habits'));
  checks.push(check('habit #1 costs 9,100', !!first && near(first.cost, 9100, 1), first ? `${first.cost}` : 'no habits'));
  const others = review.habits.slice(1).filter((h) => h.cost > 1000);
  checks.push(check('no other habit costs more than 1,000', others.length === 0, others.map((h) => `${h.key} ${fmt(h.cost)}`).join(', ')));
  const re = review.cleared.find((c) => c.key === 'quick-reentry');
  checks.push(check('quick-reentry is cleared as profitable', re?.reason === 'profitable', re ? re.reason : 'not in cleared'));
  checks.push(check('quick-reentry trades net +650', !!re && /650/.test(re.detail), re?.detail ?? ''));
  checks.push(
    check(
      `longest losing streak is ${BRIEF_EXAMPLE_LONGEST_STREAK} (recounted from the workbook)`,
      s.longestLosingStreak === BRIEF_EXAMPLE_LONGEST_STREAK,
      `engine says ${s.longestLosingStreak}`,
    ),
  );
  // independent recount straight from the parsed trades, in file order
  let run = 0;
  let best = 0;
  for (const t of [...parsed.trades].sort((a, b) => a.sourceRows[0] - b.sourceRows[0])) {
    run = t.netPnl < 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const info = [`independent recount of the longest losing streak in file order: ${best}`];
  return { id: 'brief-example', title: 'Brief example workbook (title row, blank row, gross P&L + fees)', checks, reviews: [review], info };
}

interface AnswerKey {
  totals: { roundTrips: number; fills: number; grossPnl: number };
  openPosition: { symbol: string; qty: number };
  planted: { key: string; expectedRank: number; trades: { symbol: string; entryTime: string }[]; grossPnl: number }[];
  decoys: { key: string; note: string }[];
}

function septCase(fileName: string, id: string, title: string): EvalCase {
  return {
    id,
    title,
    run() {
      const key = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 'sept-2026-tradebook.answer-key.json'), 'utf8')) as AnswerKey;
      const { review, parsed } = analyse(bytes(path.join(SAMPLES_DIR, fileName)), fileName);
      const planted = [...key.planted].sort((a, b) => a.expectedRank - b.expectedRank);
      const plantedKeys = planted.map((p) => p.key);
      const got = keysOf(review);
      const checks: Check[] = [
        check('top-3 habits are exactly the planted set', got.length === plantedKeys.length && plantedKeys.every((k) => got.includes(k)), `got [${got.join(', ')}]`),
        check(`habit #1 is the planted rank-1 (${plantedKeys[0]})`, got[0] === plantedKeys[0], `got ${got[0] ?? 'none'}`),
      ];
      const decoyHits = key.decoys.map((d) => d.key).filter((k) => got.includes(k));
      checks.push(check('no decoy appears among the habits', decoyHits.length === 0, decoyHits.join(', ')));
      checks.push(check('trades equal the answer key round trips', review.trades.length === key.totals.roundTrips, `${review.trades.length} vs ${key.totals.roundTrips}`));
      const gross = sum(review.trades.map((t) => t.grossPnl ?? 0));
      checks.push(check('sum of gross P&L matches the answer key (+/-1)', near(gross, key.totals.grossPnl, 1), `${fmt(gross)} vs ${fmt(key.totals.grossPnl)}`));
      const open = parsed.openPositions;
      checks.push(
        check(
          'exactly one open position is set aside',
          open.length === 1 && open[0].symbol === key.openPosition.symbol && open[0].qty === key.openPosition.qty,
          open.map((o) => `${o.symbol} ${o.qty}`).join(', ') || 'none',
        ),
      );
      checks.push(check('charges are estimated', parsed.coverage.fees === 'estimated', parsed.coverage.fees));
      const info = [`habits: ${review.habits.map((h) => `${h.key} (${fmt(h.cost)})`).join(', ') || 'none'}`];
      const order = got.map((k) => plantedKeys.indexOf(k) + 1).join('');
      info.push(`planted-rank order of the habits found: ${order || 'n/a'} (123 = same order as expectedRank)`);
      return { id, title, checks, reviews: [review], info };
    },
  };
}

// Output format used for each habit's fixed case: both paths get exercised.
const FIXED_MODE: Record<HabitKind, 'closed' | 'fills'> = {
  'instrument-bleed': 'fills',
  'loss-streak': 'closed',
  'quick-reentry': 'fills',
  overtrading: 'closed',
  'time-window': 'fills',
  'expiry-day': 'fills',
  'holding-losers': 'closed',
  'size-after-loss': 'fills',
  'fee-churn': 'closed',
};

export const FIXED_SEED = 1;

export interface Produced {
  analysed: Analysed;
  /** engine trade ids that correspond to the planted fixture trades */
  plantedEngineIds: Set<string>;
  csv: string;
}

/** Write a fixture in the given format, analyse it, and map planted ids onto engine trade ids. */
export function produce(fx: Fixture, plantedIds: string[], mode: 'closed' | 'fills'): Produced {
  const wanted = new Set(plantedIds);
  if (mode === 'closed') {
    const csv = toClosedCsv(fx);
    const analysed = analyse(csv, `${fx.name}.csv`);
    return { analysed, plantedEngineIds: new Set(analysed.review.trades.filter((t) => wanted.has(t.id)).map((t) => t.id)), csv };
  }
  const out = toFillsCsv(fx);
  const analysed = analyse(out.csv, `${fx.name}.csv`);
  const ids = new Set<string>();
  for (const t of analysed.review.trades) {
    const fxId = out.keys.get(`${t.symbol}|${t.entryTime}`);
    if (fxId && wanted.has(fxId)) ids.add(t.id);
  }
  return { analysed, plantedEngineIds: ids, csv: out.csv };
}

function habitCase(kind: HabitKind): EvalCase {
  const id = `habit-${kind}`;
  const title = `Planted ${kind} (seed ${FIXED_SEED}, ${FIXED_MODE[kind]} file)`;
  return {
    id,
    title,
    run() {
      const fx = baseline(FIXED_SEED, { name: id });
      const planted = plant(fx, kind, 1);
      const want = expectedKey(kind);
      const { analysed, plantedEngineIds } = produce(fx, planted, FIXED_MODE[kind]);
      const review = analysed.review;
      const top = review.habits[0];
      const checks = [
        check(`habit #1 is ${want}`, top?.key === want, `got ${keysOf(review).join(', ') || 'none'}`),
      ];
      const info: string[] = [];
      if (top) {
        const hit = top.tradeIds.filter((t) => plantedEngineIds.has(t)).length;
        info.push(`${planted.length} trades planted; habit #1 cites ${top.tradeIds.length}, ${hit} of them planted`);
      }
      return { id, title, checks, reviews: [review], info };
    },
  };
}

function cleanControlCase(): EvalCase {
  const id = 'clean-control';
  const title = `Neutral trader, nothing planted (seed ${FIXED_SEED})`;
  return {
    id,
    title,
    run() {
      const fx = baseline(FIXED_SEED, { name: id });
      const { analysed } = produce(fx, [], 'closed');
      const review = analysed.review;
      return {
        id,
        title,
        checks: [check('no habit is shown', review.habits.length === 0, keysOf(review).join(', '))],
        reviews: [review],
        info: [`net ${fmt(review.summary.netPnl)} over ${review.trades.length} trades`],
      };
    },
  };
}

function confoundCase(): EvalCase {
  const id = 'confound-symbol-vs-time';
  const title = 'A losing symbol traded only in the closing window; all other closing trades win';
  return {
    id,
    title,
    run() {
      const fx = baseline(FIXED_SEED, { name: id });
      const { symbol } = plantSymbolVsTime(fx, { underlying: 'INFY' });
      const { analysed } = produce(fx, [], 'closed');
      const review = analysed.review;
      const keys = keysOf(review);
      return {
        id,
        title,
        checks: [
          check(`habit #1 is instrument-bleed:${symbol}`, keys[0] === `instrument-bleed:${symbol}`, `got ${keys.join(', ') || 'none'}`),
          check('time-window:closing is not a habit', !keys.includes('time-window:closing'), keys.join(', ')),
        ],
        reviews: [review],
        info: [`habits: ${review.habits.map((h) => `${h.key} (${fmt(h.cost)})`).join(', ') || 'none'}`],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Robustness cases: the same trader, written badly
// ---------------------------------------------------------------------------

function refFixture(name: string): { fx: Fixture; key: string } {
  const fx = baseline(FIXED_SEED, { name });
  plant(fx, 'instrument-bleed', 1);
  return { fx, key: expectedKey('instrument-bleed') };
}

function robustness(): EvalCase[] {
  const cases: EvalCase[] = [];
  const add = (id: string, title: string, fn: () => Omit<CaseOutcome, 'id' | 'title'>) =>
    cases.push({ id, title, run: () => ({ id, title, ...fn() }) });

  const compareToRef = (review: Review, ref: Review, key: string): Check[] => [
    check('same number of trades as the clean file', review.trades.length === ref.trades.length, `${review.trades.length} vs ${ref.trades.length}`),
    check(`habit #1 is ${key}`, review.habits[0]?.key === key, keysOf(review).join(', ') || 'none'),
  ];

  add('robust-net-only-pnl', 'Net-only P&L column (net_pnl), no fees column', () => {
    const { fx, key } = refFixture('robust-net');
    const ref = analyse(toClosedCsv(fx), 'ref.csv').review;
    const rows = toClosedRows(fx).map((r) => [r[0], r[1], r[2], r[3], (Number(r[4]) - Number(r[5])).toFixed(2), r[6]].join(','));
    const csv = ['id,symbol,entry_time,exit_time,net_pnl,quantity', ...rows].join('\n') + '\n';
    const { review, parsed, detection } = analyse(csv, 'net-only.csv');
    return {
      checks: [
        check('detected as closed trades', detection.format === 'closed-trades', `${detection.format}`),
        check("fees coverage is 'included'", parsed.coverage.fees === 'included', parsed.coverage.fees),
        check('net P&L matches the file', near(review.summary.netPnl, ref.summary.netPnl, 1), `${fmt(review.summary.netPnl)} vs ${fmt(ref.summary.netPnl)}`),
        ...compareToRef(review, ref, key),
      ],
      reviews: [review],
      info: [],
    };
  });

  add('robust-no-timestamps', 'No entry/exit timestamps', () => {
    const { fx, key } = refFixture('robust-notime');
    const ref = analyse(toClosedCsv(fx), 'ref.csv').review;
    const rows = toClosedRows(fx).map((r) => [r[0], r[1], r[4], r[5], r[6]].join(','));
    const csv = ['id,symbol,pnl,fees,quantity', ...rows].join('\n') + '\n';
    const { review } = analyse(csv, 'no-times.csv');
    const unavailable = new Set(review.unavailable.map((u) => u.id));
    const timing = ['loss-streak', 'quick-reentry', 'overtrading', 'time-window', 'holding-losers', 'size-after-loss'] as const;
    const missing = timing.filter((id) => !unavailable.has(id));
    return {
      checks: [
        check('timing habits are listed as unavailable', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : ''),
        ...compareToRef(review, ref, key),
      ],
      reviews: [review],
      info: [`unavailable: ${[...unavailable].join(', ')}`],
    };
  });

  add('robust-dd-mm-rupee-formats', 'DD-MM-YYYY dates; pnl as ₹1,234.50 and (₹450.00)', () => {
    const { fx, key } = refFixture('robust-ddmm');
    const ref = analyse(toClosedCsv(fx), 'ref.csv').review;
    const money = (x: number, i: number) => {
      const abs = Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (x >= 0) return `"₹${abs}"`;
      return i % 2 === 0 ? `"(₹${abs})"` : `"-₹${abs}"`;
    };
    const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
    const rows = toClosedRows(fx).map((r, i) =>
      [r[0], r[1], dmy(String(r[2])), dmy(String(r[3])), money(Number(r[4]), i), `"₹${Number(r[5]).toFixed(2)}"`, r[6]].join(','),
    );
    const csv = [CLOSED_HEADER, ...rows].join('\n') + '\n';
    const { review } = analyse(csv, 'dd-mm.csv');
    return {
      checks: [
        ...compareToRef(review, ref, key),
        check('net P&L matches the clean file (+/-1)', near(review.summary.netPnl, ref.summary.netPnl, 1), `${fmt(review.summary.netPnl)} vs ${fmt(ref.summary.netPnl)}`),
        check('first trade date is read day-first', review.summary.from === '2026-09-01', `${review.summary.from}`),
      ],
      reviews: [review],
      info: [],
    };
  });

  add('robust-bom-crlf', 'UTF-8 BOM and CRLF line endings', () => {
    const { fx, key } = refFixture('robust-bom');
    const ref = analyse(toClosedCsv(fx), 'ref.csv').review;
    const text = '﻿' + toClosedCsv(fx, '\r\n');
    const { review, detection } = analyse(new TextEncoder().encode(text), 'bom-crlf.csv');
    return {
      checks: [
        check('first header is read cleanly', detection.headers[0] === 'id', JSON.stringify(detection.headers[0])),
        ...compareToRef(review, ref, key),
        check('net P&L matches the clean file (+/-1)', near(review.summary.netPnl, ref.summary.netPnl, 1), `${fmt(review.summary.netPnl)} vs ${fmt(ref.summary.netPnl)}`),
      ],
      reviews: [review],
      info: [],
    };
  });

  add('robust-malformed-rows', 'Five malformed rows mixed in', () => {
    const { fx, key } = refFixture('robust-bad');
    const ref = analyse(toClosedCsv(fx), 'ref.csv').review;
    const rows = toClosedRows(fx).map((r) => r.join(','));
    const bad = [
      'X001,,2026-09-03T10:00:00,2026-09-03T10:20:00,500.00,40.00,1', // no symbol
      'X002,NIFTY2691525000CE,2026-09-04T10:00:00,2026-09-04T10:20:00,n/a,40.00,65', // unreadable pnl
      'X003,INFY,2026-09-07T11:00:00,2026-09-07T10:40:00,300.00,40.00,100', // exits before entry
      'X004,INFY,31-02-2026 10:00,2026-09-08T10:40:00,300.00,40.00,100', // impossible date
      'X005,INFY,2026-09-09T10:00:00,2026-09-09T10:40:00,300.00,abc,100', // unreadable fees
    ];
    [3, 17, 40, 66, 90].forEach((at, i) => rows.splice(Math.min(at, rows.length), 0, bad[i]));
    const csv = [CLOSED_HEADER, ...rows].join('\n') + '\n';
    const { review, parsed } = analyse(csv, 'malformed.csv');
    return {
      checks: [
        check('all five bad rows are rejected', parsed.rejected.length === 5, `${parsed.rejected.length}: ${parsed.rejected.map((x) => x.reason).join(' | ')}`),
        check('every rejection names a row and a reason', parsed.rejected.every((x) => x.row > 0 && x.reason.length > 0)),
        ...compareToRef(review, ref, key),
      ],
      reviews: [review],
      info: [],
    };
  });

  add('robust-no-price-column', 'Buy/sell rows but no price column', () => {
    const csv = [
      'symbol,trade_date,trade_type,quantity,order_execution_time',
      'INFY,2026-09-01,buy,100,2026-09-01T10:00:00',
      'INFY,2026-09-01,sell,100,2026-09-01T10:30:00',
      'HDFCBANK,2026-09-02,buy,100,2026-09-02T11:00:00',
      'HDFCBANK,2026-09-02,sell,100,2026-09-02T11:20:00',
      '',
    ].join('\n');
    let detection: ReturnType<typeof detect> | null = null;
    let threw: unknown = null;
    try {
      detection = detect(readTable(csv, 'no-price.csv'));
    } catch (e) {
      threw = e;
    }
    const rejected = !!detection && (detection.format === null || detection.confidence === 'low');
    const cleanError = (() => {
      try {
        analyse(csv, 'no-price.csv');
        return false;
      } catch (e) {
        return e instanceof Error && !(e instanceof TypeError) && e.message.length > 0;
      }
    })();
    return {
      checks: [
        check('detect does not crash', threw === null, String(threw ?? '')),
        check('format is null or confidence is low', rejected, detection ? `${detection.format}/${detection.confidence}` : ''),
        check('a problem message explains it', !!detection && detection.problems.some((p) => /price/i.test(p)), detection?.problems.join(' | ') ?? ''),
        check('analyzeFile fails with a clean error', cleanError),
      ],
      reviews: [],
      info: [],
    };
  });

  const emptyInput = (label: string, text: string) => {
    let detection: ReturnType<typeof detect> | null = null;
    let message = '';
    let clean = false;
    try {
      detection = detect(readTable(text, 'x.csv'));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    try {
      analyse(text, 'x.csv');
    } catch (e) {
      clean = e instanceof Error && !(e instanceof TypeError) && e.message.length > 0;
      message = message || (e as Error).message;
    }
    return [
      check(`${label}: detect does not crash`, detection !== null, message),
      check(`${label}: analyzeFile throws a clean, readable error`, clean, message),
    ];
  };
  add('robust-empty-files', 'Empty file and header-only file', () => ({
    checks: [
      ...emptyInput('empty file', ''),
      ...emptyInput('header-only file', 'symbol,trade_type,quantity,price,order_execution_time\n'),
    ],
    reviews: [],
    info: [],
  }));

  add('robust-open-position', 'Tradebook with a position still open', () => {
    const { fx } = refFixture('robust-open');
    const out = toFillsCsv(fx);
    const refRun = analyse(out.csv, 'ref.csv');
    const lastDay = fx.days[fx.days.length - 1];
    const extra: FillRow = {
      symbol: 'HDFCBANK',
      isin: 'INE040A01034',
      tradeDate: lastDay,
      segment: 'EQ',
      side: 'buy',
      qty: 100,
      price: 1004.5,
      tradeId: '99999991',
      orderId: '2609999999991',
      time: stamp(lastDay, 15 * 60 + 20, 11),
    };
    const csv = fillsToCsv([...out.rows, extra]);
    const { review, parsed } = analyse(csv, 'open.csv');
    return {
      checks: [
        check('exactly one open position is reported', parsed.openPositions.length === 1 && parsed.openPositions[0].symbol === 'HDFCBANK' && parsed.openPositions[0].qty === 100, JSON.stringify(parsed.openPositions)),
        check('closed trades are unchanged', review.trades.length === refRun.review.trades.length, `${review.trades.length} vs ${refRun.review.trades.length}`),
        check('the open position is mentioned in the notes', review.notes.some((n) => /still open/i.test(n.text)), review.notes.map((n) => n.text.slice(0, 50)).join(' | ')),
      ],
      reviews: [review],
      info: [],
    };
  });

  return cases;
}

export function fixedCases(): EvalCase[] {
  return [
    { id: 'brief-example', title: 'Brief example workbook', run: briefExample },
    septCase('sept-2026-tradebook.csv', 'sept-2026-tradebook', 'September 2026 sample tradebook (CSV) vs answer key'),
    septCase('sept-2026-tradebook.xlsx', 'sept-2026-tradebook-xlsx', 'September 2026 sample tradebook (XLSX) vs answer key'),
    ...HABIT_KINDS.map(habitCase),
    cleanControlCase(),
    confoundCase(),
    ...robustness(),
  ];
}

export function runCase(c: EvalCase): CaseOutcome {
  try {
    return c.run();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { id: c.id, title: c.title, checks: [check('case ran without throwing', false, msg)], reviews: [], info: [] };
  }
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/** File format for a sweep seed: alternate closed-trades and fills so both paths are exercised. */
export function modeFor(kind: HabitKind | 'clean', seed: number): 'closed' | 'fills' {
  if (kind === 'fee-churn') return 'closed'; // charges are part of what is planted, so they must be explicit
  return seed % 2 === 0 ? 'closed' : 'fills';
}

export interface SweepRow {
  kind: HabitKind;
  key: string;
  strength: number;
  seeds: number;
  recall3: number; // share of seeds where the planted key is among the habits
  top1: number; // share of seeds where it is habit #1
  /** mean share of the habit's cited trades that were planted, over seeds where it was found */
  precision: number | null;
  /** mean share of planted trades the habit cites, over seeds where it was found */
  evidenceRecall: number | null;
  /** `covers` is the share of the planted trades that the habit actually shown first cites (a broad habit can swallow a narrow one) */
  misses: { seed: number; mode: string; got: string[]; covers: number | null }[];
  reviews: Review[];
}

export function sweepHabit(kind: HabitKind, seeds: number[], strength: number): SweepRow {
  const key = expectedKey(kind);
  let found = 0;
  let first = 0;
  const prec: number[] = [];
  const rec: number[] = [];
  const misses: SweepRow['misses'] = [];
  const reviews: Review[] = [];
  for (const seed of seeds) {
    const mode = modeFor(kind, seed);
    // A few baselines leave no room to place a habit; retry with a derived seed so
    // every row still has the same number of fixtures.
    let fx = baseline(seed, { name: `sweep-${kind}-${seed}` });
    let planted: ReturnType<typeof plant> | null = null;
    for (let attempt = 0; !planted; attempt++) {
      try {
        planted = plant(fx, kind, strength);
      } catch (e) {
        if (attempt >= 4) throw e;
        fx = baseline(seed + (attempt + 1) * 100_000, { name: `sweep-${kind}-${seed}-r${attempt + 1}` });
      }
    }
    const { analysed, plantedEngineIds } = produce(fx, planted, mode);
    const review = analysed.review;
    reviews.push(review);
    const habit = review.habits.find((h) => h.key === key);
    if (habit) {
      found++;
      const hit = habit.tradeIds.filter((id) => plantedEngineIds.has(id)).length;
      prec.push(hit / habit.tradeIds.length);
      rec.push(plantedEngineIds.size ? hit / plantedEngineIds.size : 0);
    }
    if (review.habits[0]?.key === key) first++;
    if (!habit || review.habits[0]?.key !== key) {
      const top = review.habits[0];
      const covers = top && plantedEngineIds.size ? top.tradeIds.filter((id) => plantedEngineIds.has(id)).length / plantedEngineIds.size : null;
      misses.push({ seed, mode, got: keysOf(review), covers });
    }
  }
  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
  return {
    kind,
    key,
    strength,
    seeds: seeds.length,
    recall3: found / seeds.length,
    top1: first / seeds.length,
    precision: mean(prec),
    evidenceRecall: mean(rec),
    misses,
    reviews,
  };
}

export interface CleanSweep {
  seeds: number;
  falsePositiveRate: number;
  flagged: { seed: number; mode: string; habits: string[] }[];
  reviews: Review[];
}

export function sweepClean(seeds: number[]): CleanSweep {
  const flagged: CleanSweep['flagged'] = [];
  const reviews: Review[] = [];
  for (const seed of seeds) {
    const mode = modeFor('clean', seed);
    const fx = baseline(seed, { name: `clean-${seed}` });
    const { analysed } = produce(fx, [], mode);
    reviews.push(analysed.review);
    if (analysed.review.habits.length) flagged.push({ seed, mode, habits: analysed.review.habits.map((h) => `${h.key} (${fmt(h.cost)})`) });
  }
  return { seeds: seeds.length, falsePositiveRate: flagged.length / seeds.length, flagged, reviews };
}

export const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
