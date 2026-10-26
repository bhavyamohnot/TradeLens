import { describe, expect, it } from 'vitest';
import { buildTrades } from '../src/engine/fills';
import type { Fill, Side } from '../src/engine/types';

let row = 0;
function fill(symbol: string, side: Side, qty: number, price: number, time: string, extra: Partial<Fill> = {}): Fill {
  return { row: ++row, symbol, side, qty, price, time: `2026-09-02T${time}`, fees: null, orderId: null, ...extra };
}
const build = (fills: Fill[]) => buildTrades(fills, { estimateFees: false });

describe('buildTrades', () => {
  it('turns a buy and a sell into one long trade', () => {
    row = 0;
    const { trades, openPositions } = build([fill('INFY', 'BUY', 100, 1500, '10:00:00'), fill('INFY', 'SELL', 100, 1505, '10:30:00')]);
    expect(openPositions).toEqual([]);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.id).toBe('T001');
    expect(t.symbol).toBe('INFY');
    expect(t.direction).toBe('LONG');
    expect(t.qty).toBe(100);
    expect(t.grossPnl).toBe(500);
    expect(t.entryTime).toBe('2026-09-02T10:00:00');
    expect(t.exitTime).toBe('2026-09-02T10:30:00');
    expect(t.holdMinutes).toBe(30);
    expect(t.netPnl).toBe(500);
    expect(t.sourceRows).toEqual([1, 2]);
  });

  it('handles a short-first trade (sell, then buy back)', () => {
    row = 0;
    const win = build([fill('TCS', 'SELL', 50, 200, '10:00:00'), fill('TCS', 'BUY', 50, 190, '10:20:00')]).trades[0];
    expect(win.direction).toBe('SHORT');
    expect(win.grossPnl).toBe(500);
    row = 0;
    const loss = build([fill('TCS', 'SELL', 50, 200, '10:00:00'), fill('TCS', 'BUY', 50, 210, '10:20:00')]).trades[0];
    expect(loss.grossPnl).toBe(-500);
  });

  it('keeps a scale-in inside one trade', () => {
    row = 0;
    const { trades } = build([
      fill('INFY', 'BUY', 50, 100, '10:00:00'),
      fill('INFY', 'BUY', 50, 102, '10:05:00'),
      fill('INFY', 'SELL', 100, 104, '10:40:00'),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].qty).toBe(100);
    // sells 10,400 less buys 5,000 + 5,100
    expect(trades[0].grossPnl).toBe(300);
    expect(trades[0].sourceRows).toEqual([1, 2, 3]);
    expect(trades[0].entryTime).toBe('2026-09-02T10:00:00');
  });

  it('keeps a partial exit inside one trade', () => {
    row = 0;
    const { trades } = build([
      fill('INFY', 'BUY', 100, 100, '10:00:00'),
      fill('INFY', 'SELL', 40, 103, '10:10:00'),
      fill('INFY', 'SELL', 60, 101, '10:25:00'),
    ]);
    expect(trades).toHaveLength(1);
    // sells 4,120 + 6,060 less buys 10,000
    expect(trades[0].grossPnl).toBe(180);
    expect(trades[0].exitTime).toBe('2026-09-02T10:25:00');
    expect(trades[0].holdMinutes).toBe(25);
  });

  it('closes the episode when a fill flips the position and opens the opposite one', () => {
    row = 0;
    const { trades, openPositions } = build([
      fill('INFY', 'BUY', 50, 100, '10:00:00'),
      fill('INFY', 'SELL', 80, 110, '10:30:00'), // closes the 50 long, opens a 30 short at 110
      fill('INFY', 'BUY', 30, 105, '11:00:00'),
    ]);
    expect(openPositions).toEqual([]);
    expect(trades).toHaveLength(2);
    expect(trades[0].direction).toBe('LONG');
    expect(trades[0].qty).toBe(50);
    expect(trades[0].grossPnl).toBe(500); // 50 x 110 - 50 x 100
    expect(trades[0].exitTime).toBe('2026-09-02T10:30:00');
    expect(trades[1].direction).toBe('SHORT');
    expect(trades[1].qty).toBe(30);
    expect(trades[1].grossPnl).toBe(150); // 30 x 110 - 30 x 105
    expect(trades[1].entryTime).toBe('2026-09-02T10:30:00');
  });

  it('leaves a flipped remainder open when it is never closed', () => {
    row = 0;
    const { trades, openPositions } = build([fill('INFY', 'BUY', 50, 100, '10:00:00'), fill('INFY', 'SELL', 80, 110, '10:30:00')]);
    expect(trades).toHaveLength(1);
    expect(trades[0].grossPnl).toBe(500);
    expect(openPositions).toEqual([{ symbol: 'INFY', qty: -30, sinceTime: '2026-09-02T10:30:00' }]);
  });

  it('returns an unfinished position as open and excludes it from the trades', () => {
    row = 0;
    const { trades, openPositions } = build([
      fill('INFY', 'BUY', 100, 100, '10:00:00'),
      fill('INFY', 'SELL', 100, 101, '10:20:00'),
      fill('HDFCBANK', 'BUY', 200, 1000, '15:20:00'),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('INFY');
    expect(trades[0].grossPnl).toBe(100);
    expect(openPositions).toEqual([{ symbol: 'HDFCBANK', qty: 200, sinceTime: '2026-09-02T15:20:00' }]);
  });

  it('reports a position that is still partly open', () => {
    row = 0;
    const { trades, openPositions } = build([fill('INFY', 'BUY', 100, 100, '10:00:00'), fill('INFY', 'SELL', 40, 103, '10:10:00')]);
    expect(trades).toEqual([]);
    expect(openPositions).toEqual([{ symbol: 'INFY', qty: 60, sinceTime: '2026-09-02T10:00:00' }]);
  });

  it('keeps two interleaved symbols apart', () => {
    row = 0;
    const { trades, openPositions } = build([
      fill('AAA', 'BUY', 10, 100, '10:00:00'),
      fill('BBB', 'SELL', 20, 50, '10:05:00'),
      fill('AAA', 'SELL', 10, 103, '10:10:00'),
      fill('BBB', 'BUY', 20, 48, '10:20:00'),
    ]);
    expect(openPositions).toEqual([]);
    expect(trades.map((t) => [t.symbol, t.direction, t.grossPnl])).toEqual([
      ['AAA', 'LONG', 30],
      ['BBB', 'SHORT', 40],
    ]);
    expect(trades.map((t) => t.id)).toEqual(['T001', 'T002']);
  });

  it('starts a new trade each time a symbol goes flat and comes back, whatever the input order', () => {
    row = 0;
    const { trades } = build([
      fill('AAA', 'SELL', 10, 101, '10:10:00'),
      fill('AAA', 'BUY', 10, 100, '10:00:00'),
      fill('AAA', 'BUY', 10, 102, '11:00:00'),
      fill('AAA', 'SELL', 10, 99, '11:30:00'),
    ]);
    expect(trades.map((t) => t.grossPnl)).toEqual([10, -30]);
    expect(trades.map((t) => t.entryTime?.slice(11, 16))).toEqual(['10:00', '11:00']);
  });

  it('uses source row order for fills with the same timestamp', () => {
    row = 0;
    const { trades } = build([
      fill('AAA', 'BUY', 10, 100, '10:00:00'),
      fill('AAA', 'SELL', 10, 101, '10:00:00'),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0].grossPnl).toBe(10);
    expect(trades[0].holdMinutes).toBe(0);
  });

  it('uses reported charges, pro-rated across a flip', () => {
    row = 0;
    const { trades } = build([
      fill('AAA', 'BUY', 50, 100, '10:00:00', { fees: 10 }),
      fill('AAA', 'SELL', 80, 110, '10:30:00', { fees: 16 }), // 50/80 closes the long, 30/80 opens the short
      fill('AAA', 'BUY', 30, 105, '11:00:00', { fees: 6 }),
    ]);
    expect(trades[0].fees).toBeCloseTo(10 + 10, 2);
    expect(trades[0].feesSource).toBe('reported');
    expect(trades[0].netPnl).toBeCloseTo(500 - 20, 2);
    expect(trades[1].fees).toBeCloseTo(6 + 6, 2);
    expect(trades[1].netPnl).toBeCloseTo(150 - 12, 2);
  });

  it('estimates charges when asked and none are given', () => {
    row = 0;
    const out = buildTrades(
      [fill('NIFTY2690825000CE', 'BUY', 65, 120, '10:00:00'), fill('NIFTY2690825000CE', 'SELL', 65, 130, '10:30:00')],
      { estimateFees: true },
    );
    const t = out.trades[0];
    expect(t.feesSource).toBe('estimated');
    expect(t.fees).toBeGreaterThan(0);
    expect(t.grossPnl).toBe(650);
    expect(t.netPnl).toBeCloseTo(650 - t.fees, 2);
  });
});
