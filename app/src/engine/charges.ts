import type { InstrumentKind, Side } from './types';

// Approximate NSE retail charges, used only when the file has no charges
// column (broker tradebooks usually don't). Shown to the user as an estimate.
// Rates as understood in Oct 2026; verify against the broker's contract notes.
const RATES = {
  OPTION: { stt: 0.0015, sttSide: 'SELL', exchange: 0.0003503, stamp: 0.00003 },
  FUTURE: { stt: 0.0005, sttSide: 'SELL', exchange: 0.0000173, stamp: 0.00002 },
  EQUITY: { stt: 0.00025, sttSide: 'SELL', exchange: 0.0000297, stamp: 0.00003 },
} as const;
const BROKERAGE_CAP = 20; // ₹ per executed order (flat-fee discount broker)
const BROKERAGE_PCT = 0.0003; // or 0.03% if lower
const SEBI_FEE = 10 / 1e7; // ₹10 per crore
const GST = 0.18; // on brokerage + exchange + SEBI fees

export interface ChargeInput {
  kind: InstrumentKind;
  side: Side;
  qty: number;
  price: number;
  /** false for the 2nd+ fill of the same order: brokerage is charged once per order. */
  chargeBrokerage: boolean;
}

export function estimateCharges(f: ChargeInput): number {
  const rates = RATES[f.kind === 'UNKNOWN' ? 'OPTION' : f.kind];
  const turnover = f.qty * f.price;
  const brokerage = f.chargeBrokerage ? Math.min(BROKERAGE_CAP, turnover * BROKERAGE_PCT) : 0;
  const stt = f.side === rates.sttSide ? turnover * rates.stt : 0;
  const exchange = turnover * rates.exchange;
  const sebi = turnover * SEBI_FEE;
  const stamp = f.side === 'BUY' ? turnover * rates.stamp : 0;
  const gst = (brokerage + exchange + sebi) * GST;
  return brokerage + stt + exchange + sebi + stamp + gst;
}
