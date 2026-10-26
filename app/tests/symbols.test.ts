import { describe, expect, it } from 'vitest';
import { parseSymbol } from '../src/engine/symbols';

describe('parseSymbol', () => {
  it('reads a weekly option: month digit, two-digit day', () => {
    expect(parseSymbol('NIFTY2690825000CE')).toEqual({
      underlying: 'NIFTY',
      kind: 'OPTION',
      expiry: '2026-09-08',
      strike: 25000,
      optionType: 'CE',
    });
  });

  it('reads a weekly put', () => {
    const p = parseSymbol('NIFTY2692224500PE');
    expect(p).toMatchObject({ underlying: 'NIFTY', kind: 'OPTION', expiry: '2026-09-22', strike: 24500, optionType: 'PE' });
  });

  it.each([
    ['NIFTY26O0625000CE', '2026-10-06'],
    ['NIFTY26N1024800PE', '2026-11-10'],
    ['NIFTY26D0125200CE', '2026-12-01'],
    ['NIFTY26D2925200CE', '2026-12-29'],
  ])('reads the O / N / D month codes of a weekly option (%s)', (symbol, expiry) => {
    const p = parseSymbol(symbol);
    expect(p.kind).toBe('OPTION');
    expect(p.underlying).toBe('NIFTY');
    expect(p.expiry).toBe(expiry);
  });

  it('reads a monthly option: expiry is the last Tuesday for Sep 2025 onwards', () => {
    expect(parseSymbol('BANKNIFTY26SEP55000PE')).toEqual({
      underlying: 'BANKNIFTY',
      kind: 'OPTION',
      expiry: '2026-09-29',
      strike: 55000,
      optionType: 'PE',
    });
    expect(parseSymbol('NIFTY26OCT25000CE').expiry).toBe('2026-10-27');
    expect(parseSymbol('NIFTY26NOV25000CE').expiry).toBe('2026-11-24');
    expect(parseSymbol('NIFTY26DEC25000CE').expiry).toBe('2026-12-29');
    expect(parseSymbol('NIFTY25SEP25000CE').expiry).toBe('2025-09-30'); // first Tuesday-era month
  });

  it('uses the last Thursday before September 2025', () => {
    expect(parseSymbol('NIFTY25AUG24500CE').expiry).toBe('2025-08-28');
    expect(parseSymbol('NIFTY25JUN24500CE').expiry).toBe('2025-06-26');
  });

  it('reads a future with its monthly expiry', () => {
    expect(parseSymbol('RELIANCE26SEPFUT')).toEqual({
      underlying: 'RELIANCE',
      kind: 'FUTURE',
      expiry: '2026-09-29',
      strike: null,
      optionType: null,
    });
  });

  it('reads equity symbols, with or without a series suffix', () => {
    expect(parseSymbol('HDFCBANK')).toMatchObject({ underlying: 'HDFCBANK', kind: 'EQUITY', expiry: null, strike: null, optionType: null });
    expect(parseSymbol('HDFCBANK-EQ')).toMatchObject({ underlying: 'HDFCBANK', kind: 'EQUITY' });
    expect(parseSymbol('M&M')).toMatchObject({ underlying: 'M&M', kind: 'EQUITY' });
  });

  it('treats a bare index name as unknown', () => {
    expect(parseSymbol('BANKNIFTY')).toMatchObject({ underlying: 'BANKNIFTY', kind: 'UNKNOWN', expiry: null });
    expect(parseSymbol('NIFTY')).toMatchObject({ underlying: 'NIFTY', kind: 'UNKNOWN' });
  });

  it('ignores case and stray spaces', () => {
    expect(parseSymbol(' nifty2690825000ce ')).toMatchObject({ underlying: 'NIFTY', kind: 'OPTION', expiry: '2026-09-08', strike: 25000 });
  });

  it('does not mistake an ordinary equity for an option', () => {
    expect(parseSymbol('INFY').kind).toBe('EQUITY');
    expect(parseSymbol('TCS').kind).toBe('EQUITY');
  });
});
