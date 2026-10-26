import { describe, expect, it } from 'vitest';
import { parseTime } from '../src/engine/time';

describe('parseTime', () => {
  it.each([
    ['2026-09-02 10:15', '2026-09-02T10:15:00'],
    ['2026-09-02 10:15:30', '2026-09-02T10:15:30'],
    ['2026-09-02T10:15:30', '2026-09-02T10:15:30'],
    ['2026-09-02T10:15', '2026-09-02T10:15:00'],
    ['2026-09-02T10:15:30.250', '2026-09-02T10:15:30'],
    ['2026-09-02T10:15:30Z', '2026-09-02T10:15:30'],
    ['2026-09-02T10:15:30+05:30', '2026-09-02T10:15:30'],
    ['02-09-2026 10:15', '2026-09-02T10:15:00'],
    ['02-09-2026 10:15:45', '2026-09-02T10:15:45'],
    ['02/09/2026 10:15', '2026-09-02T10:15:00'],
    ['02/09/2026 10:15:45', '2026-09-02T10:15:45'],
    ['1-9-2026 9:05', '2026-09-01T09:05:00'],
    ['02/09/2026 10:15 PM', '2026-09-02T22:15:00'],
    ['  2026-09-02 10:15  ', '2026-09-02T10:15:00'],
  ])('reads %s', (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });

  it('returns a bare date for date-only input', () => {
    expect(parseTime('2026-09-02')).toBe('2026-09-02');
    expect(parseTime('02/09/2026')).toBe('2026-09-02');
    expect(parseTime('02-09-2026')).toBe('2026-09-02');
  });

  it('reads day-first, never month-first', () => {
    expect(parseTime('01/02/2026')).toBe('2026-02-01');
    expect(parseTime('12/31/2026')).toBeNull(); // read as day 12, month 31, which does not exist
  });

  it('reads Excel serial numbers', () => {
    expect(parseTime(46267)).toBe('2026-09-02'); // 2 Sep 2026
    expect(parseTime(46267.4375)).toBe('2026-09-02T10:30:00');
    expect(parseTime(46267.75)).toBe('2026-09-02T18:00:00');
    expect(parseTime('46267')).toBe('2026-09-02');
  });

  it.each([
    ['31-02-2026'],
    ['31-02-2026 10:00'],
    ['2026-02-30 10:00'],
    ['2026-13-01'],
    ['2026-09-02 25:00'],
    ['2026-09-02 10:61'],
    ['29-02-2026'],
    ['not a date'],
    [''],
    ['   '],
  ])('rejects %j', (input) => {
    expect(parseTime(input)).toBeNull();
  });

  it('accepts a real leap day', () => {
    expect(parseTime('29-02-2028')).toBe('2028-02-29');
  });

  it('rejects null and nonsense numbers', () => {
    expect(parseTime(null)).toBeNull();
    expect(parseTime(0)).toBeNull();
    expect(parseTime(-5)).toBeNull();
    expect(parseTime(Number.NaN)).toBeNull();
  });
});
