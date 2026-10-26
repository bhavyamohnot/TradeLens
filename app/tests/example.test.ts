import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeFile } from '../src/engine';

const FILE = path.resolve(import.meta.dirname, '..', 'public', 'samples', 'tradelens-example.xlsx');

describe('the brief example workbook, end to end', () => {
  const { detection, parsed, review } = analyzeFile(new Uint8Array(fs.readFileSync(FILE)), 'tradelens-example.xlsx');

  it('finds the header below the title row and the blank row', () => {
    expect(detection.format).toBe('closed-trades');
    expect(detection.headerRow).toBe(2);
    expect(detection.confidence).toBe('high');
    expect(parsed.rejected).toEqual([]);
  });

  it('adds up to the known totals', () => {
    expect(review.trades).toHaveLength(60);
    expect(review.summary.grossPnl).toBe(-2990);
    expect(review.summary.fees).toBe(2100);
    expect(review.summary.netPnl).toBe(-5090);
    expect(parsed.coverage.fees).toBe('reported');
  });

  it('puts BANKNIFTY first at 9,100 and nothing else above 1,000', () => {
    expect(review.habits[0].key).toBe('instrument-bleed:BANKNIFTY');
    expect(review.habits[0].cost).toBe(9100);
    for (const h of review.habits.slice(1)) expect(h.cost).toBeLessThanOrEqual(1000);
  });

  it('clears quick re-entry as profitable (+650)', () => {
    const c = review.cleared.find((x) => x.key === 'quick-reentry');
    expect(c?.reason).toBe('profitable');
    expect(c?.detail).toContain('650');
  });

  it('counts the longest losing streak from the file', () => {
    // The brief says 20. The file has 20 BANKNIFTY losses in a row, then one more
    // REENTRY loss before the first win, so the run is 21 trades long.
    expect(review.summary.longestLosingStreak).toBe(21);
  });
});
