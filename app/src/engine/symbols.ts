import type { InstrumentKind } from './types';
import { lastWeekdayOfMonth } from './time';

export interface SymbolInfo {
  underlying: string;
  kind: InstrumentKind;
  expiry: string | null;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKLY_MONTH: Record<string, number> = { O: 10, N: 11, D: 12 };
const INDICES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX']);

/**
 * NSE monthly F&O contracts expire on the last Tuesday of the month from
 * September 2025 onwards (last Thursday before that).
 */
export function monthlyExpiry(year: number, month: number): string {
  const tuesdayEra = year > 2025 || (year === 2025 && month >= 9);
  return lastWeekdayOfMonth(year, month, tuesdayEra ? 2 : 4);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Parses Zerodha/NSE-style trading symbols. Unknown shapes fall back to the cleaned symbol. */
export function parseSymbol(raw: string): SymbolInfo {
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');

  // Monthly option: BANKNIFTY26SEP55000PE
  let m = /^([A-Z&-]+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/.exec(s);
  if (m) {
    const year = 2000 + Number(m[2]);
    return {
      underlying: m[1],
      kind: 'OPTION',
      expiry: monthlyExpiry(year, MONTHS.indexOf(m[3]) + 1),
      strike: Number(m[4]),
      optionType: m[5] as 'CE' | 'PE',
    };
  }

  // Weekly option: NIFTY2690825000CE  (YY, month 1-9/O/N/D, DD)
  m = /^([A-Z&-]+?)(\d{2})([1-9OND])(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/.exec(s);
  if (m) {
    const year = 2000 + Number(m[2]);
    const month = WEEKLY_MONTH[m[3]] ?? Number(m[3]);
    const day = Number(m[4]);
    if (day >= 1 && day <= 31) {
      return {
        underlying: m[1],
        kind: 'OPTION',
        expiry: `${year}-${pad(month)}-${pad(day)}`,
        strike: Number(m[5]),
        optionType: m[6] as 'CE' | 'PE',
      };
    }
  }

  // Future: RELIANCE26SEPFUT
  m = /^([A-Z&-]+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/.exec(s);
  if (m) {
    const year = 2000 + Number(m[2]);
    return {
      underlying: m[1],
      kind: 'FUTURE',
      expiry: monthlyExpiry(year, MONTHS.indexOf(m[3]) + 1),
      strike: null,
      optionType: null,
    };
  }

  const base = s.replace(/-(EQ|BE|BZ|SM|ST)$/, '');
  if (INDICES.has(base) || !/^[A-Z][A-Z0-9&-]*$/.test(base)) {
    return { underlying: base || s, kind: 'UNKNOWN', expiry: null, strike: null, optionType: null };
  }
  return { underlying: base, kind: 'EQUITY', expiry: null, strike: null, optionType: null };
}
