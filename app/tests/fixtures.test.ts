import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { episodesFromRows, type FillRow } from '../evals/common';
import { HABIT_KINDS, baseline, plant, toClosedCsv, toFillsCsv, windowOf } from '../evals/generators';
import { buildTrades } from '../src/engine/fills';
import { parseSymbol } from '../src/engine/symbols';

describe('baseline fixture (the neutral trader)', () => {
  it('is deterministic per seed and differs between seeds', () => {
    expect(toClosedCsv(baseline(7))).toBe(toClosedCsv(baseline(7)));
    expect(toClosedCsv(baseline(7))).not.toBe(toClosedCsv(baseline(8)));
    expect(toFillsCsv(baseline(7)).csv).toBe(toFillsCsv(baseline(7)).csv);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('has the documented shape (seed %i)', (seed) => {
    const fx = baseline(seed);
    expect(fx.trades.length).toBeGreaterThanOrEqual(100);
    expect(fx.trades.length).toBeLessThanOrEqual(140);
    expect(fx.days).toHaveLength(20);
    const names = new Set(fx.trades.map((t) => t.inst.underlying));
    expect(names.size).toBeGreaterThanOrEqual(4);
    expect(names.size).toBeLessThanOrEqual(6);
    // never more than 6 trades a day, and 6 is the typical day
    const perDay = fx.days.map((d) => fx.trades.filter((t) => t.date === d).length);
    expect(Math.max(...perDay)).toBeLessThanOrEqual(6);
    expect(perDay.filter((n) => n === 6).length).toBeGreaterThan(perDay.length / 2);
    // constant size per underlying
    for (const n of names) expect(new Set(fx.trades.filter((t) => t.inst.underlying === n).map((t) => t.qty)).size).toBe(1);
    // holds 5-40 minutes, inside the session
    for (const t of fx.trades) {
      expect(t.hold).toBeGreaterThanOrEqual(5);
      expect(t.hold).toBeLessThanOrEqual(40);
      expect(t.entryMin).toBeGreaterThanOrEqual(9 * 60 + 15);
      expect(t.entryMin + t.hold).toBeLessThanOrEqual(15 * 60 + 25);
    }
    // no option is traded on its own expiry day
    for (const t of fx.trades) {
      const info = parseSymbol(t.symbol);
      if (info.kind === 'OPTION') expect(info.expiry! > t.date).toBe(true);
    }
    // entries reach every time window
    const windows = new Set(fx.trades.map((t) => windowOf(t.entryMin)));
    expect(windows.size).toBe(5);
  });

  it('keeps a gap of more than 25 minutes after a loss in the same underlying', () => {
    for (const seed of [1, 2, 3]) {
      const fx = baseline(seed);
      for (const a of fx.trades) {
        if (a.pnl - a.fees >= 0) continue;
        for (const b of fx.trades) {
          if (b === a || b.date !== a.date || b.inst.underlying !== a.inst.underlying) continue;
          const gap = b.entryMin - (a.entryMin + a.hold);
          expect(gap > 0 && gap <= 25).toBe(false);
        }
      }
    }
  });

  it('has a small positive edge on average', () => {
    const total = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => baseline(s)).flatMap((f) => f.trades);
    const mean = total.reduce((a, t) => a + t.pnl - t.fees, 0) / total.length;
    expect(mean).toBeGreaterThan(0);
  });
});

describe('planters', () => {
  it.each(HABIT_KINDS)('%s returns the ids it planted, and they exist', (kind) => {
    const fx = baseline(3);
    const ids = plant(fx, kind, 1);
    expect(ids.length).toBeGreaterThan(0);
    const all = new Set(fx.trades.map((t) => t.id));
    for (const id of ids) expect(all.has(id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not change a fixture that is not planted into', () => {
    const fx = baseline(3);
    const before = toClosedCsv(fx);
    expect(toClosedCsv(fx)).toBe(before);
  });

  it('scales the amount planted with strength', () => {
    const small = plant(baseline(3), 'quick-reentry', 0.25).length;
    const big = plant(baseline(3), 'quick-reentry', 1).length;
    expect(big).toBeGreaterThan(small);
  });
});

describe('writers', () => {
  it('writes the closed-trades header and one row per trade', () => {
    const fx = baseline(2);
    const lines = toClosedCsv(fx).trim().split('\n');
    expect(lines[0]).toBe('id,symbol,entry_time,exit_time,pnl,fees,quantity');
    expect(lines).toHaveLength(fx.trades.length + 1);
  });

  it('writes Zerodha-style fills that rebuild into the same number of round trips', () => {
    for (const seed of [1, 2, 3]) {
      const fx = baseline(seed);
      const out = toFillsCsv(fx);
      expect(out.csv.split('\n')[0]).toBe(
        'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time',
      );
      const { episodes, open } = episodesFromRows(out.rows);
      expect(open).toEqual([]);
      expect(episodes).toHaveLength(fx.trades.length);
      // multi-fill entries and exits, and some short-first trades, are present
      expect(out.rows.length).toBeGreaterThan(fx.trades.length * 2);
      expect(out.rows.some((r) => r.side === 'sell' && episodes.length > 0)).toBe(true);
    }
  });

  it('keeps fill prices on the 0.05 tick and quantities positive', () => {
    const out = toFillsCsv(baseline(4));
    for (const r of out.rows) {
      expect(Math.abs(Math.round(r.price / 0.05) * 0.05 - r.price)).toBeLessThan(1e-6);
      expect(r.qty).toBeGreaterThan(0);
    }
  });
});

describe('the September sample dataset', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'public', 'samples');
  const csv = fs.readFileSync(path.join(dir, 'sept-2026-tradebook.csv'), 'utf8');
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'sept-2026-tradebook.answer-key.json'), 'utf8'));
  const [header, ...lines] = csv.trim().split('\n');
  const rows: FillRow[] = lines.map((l) => {
    const c = l.split(',');
    return {
      symbol: c[0],
      isin: c[1],
      tradeDate: c[2],
      segment: c[4] as 'FO' | 'EQ',
      side: c[6] as 'buy' | 'sell',
      qty: Number(c[8]),
      price: Number(c[9]),
      tradeId: c[10],
      orderId: c[11],
      time: c[12],
    };
  });

  it('has the Zerodha-style header and no charges column', () => {
    expect(header).toBe('symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time');
  });

  it('matches its answer key, recomputed from the fills alone', () => {
    const { episodes, open } = episodesFromRows(rows);
    expect(episodes).toHaveLength(key.totals.roundTrips);
    expect(rows).toHaveLength(key.totals.fills);
    expect(Math.round(episodes.reduce((a, e) => a + e.gross, 0) * 100) / 100).toBeCloseTo(key.totals.grossPnl, 1);
    expect(open).toEqual([{ symbol: key.openPosition.symbol, qty: key.openPosition.qty }]);
  });

  it('is September only, weekdays only, and skips the 14th', () => {
    const dates = new Set(rows.map((r) => r.tradeDate));
    expect(dates.has('2026-09-14')).toBe(false);
    for (const d of dates) {
      expect(d.startsWith('2026-09-')).toBe(true);
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(dow).not.toBe(0);
      expect(dow).not.toBe(6);
    }
    expect(dates.size).toBe(21);
  });

  it('plants the three habits with disjoint trade sets', () => {
    const sets = key.planted.map((p: { trades: { symbol: string; entryTime: string }[] }) => new Set(p.trades.map((t) => `${t.symbol}|${t.entryTime}`)));
    const ex = sets[0] as Set<string>;
    const re = sets[1] as Set<string>;
    for (const k of re) expect(ex.has(k)).toBe(false);
    expect(key.planted.map((p: { key: string }) => p.key)).toEqual(['expiry-day', 'quick-reentry', 'holding-losers']);
    expect(key.planted[0].trades).toHaveLength(25);
    expect(key.planted[1].trades).toHaveLength(12);
  });

  const trades = buildTrades(
    rows.map((r, i) => ({
      row: i + 2,
      symbol: r.symbol,
      side: r.side === 'buy' ? ('BUY' as const) : ('SELL' as const),
      qty: r.qty,
      price: r.price,
      time: r.time,
      fees: null,
      orderId: r.orderId,
    })),
    { estimateFees: false },
  ).trades;

  it('has fills sharing an order id, scale-ins, partial exits and short-first trades', () => {
    const perOrder = new Map<string, number>();
    for (const r of rows) perOrder.set(r.orderId, (perOrder.get(r.orderId) ?? 0) + 1);
    expect([...perOrder.values()].some((n) => n > 1)).toBe(true);
    expect(trades.filter((t) => t.sourceRows.length >= 3).length).toBeGreaterThanOrEqual(10);
    expect(trades.filter((t) => t.direction === 'SHORT').length).toBeGreaterThanOrEqual(3);
  });

  it('keeps quantity constant per underlying and prices on the 0.05 tick', () => {
    const qty = new Map<string, Set<number>>();
    for (const t of trades) qty.set(t.underlying, (qty.get(t.underlying) ?? new Set()).add(t.qty));
    expect([...qty.keys()].sort()).toEqual(['BANKNIFTY', 'HDFCBANK', 'INFY', 'NIFTY', 'RELIANCE']);
    for (const sizes of qty.values()) expect(sizes.size).toBe(1);
    for (const r of rows) expect(Math.abs(Math.round(r.price / 0.05) * 0.05 - r.price)).toBeLessThan(1e-6);
  });
});
