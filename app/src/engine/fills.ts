import type { Fill, Trade } from './types';
import { parseSymbol } from './symbols';
import { estimateCharges } from './charges';
import { hasClock, toMinutes } from './time';

interface Episode {
  symbol: string;
  pos: number; // signed open quantity
  maxAbs: number;
  direction: 'LONG' | 'SHORT';
  buyValue: number;
  sellValue: number;
  fees: number;
  feesEstimated: boolean;
  feesMissing: boolean;
  rows: number[];
  entryTime: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rebuilds round-trip trades from executions. A trade is one position episode
 * per symbol: it starts when the position leaves zero and ends when it returns
 * to zero, so scale-ins and partial exits stay one decision. A fill that
 * crosses zero closes the episode and opens a new one in the other direction.
 */
export function buildTrades(
  fills: Fill[],
  opts: { estimateFees: boolean },
): { trades: Trade[]; openPositions: { symbol: string; qty: number; sinceTime: string | null }[] } {
  const ordered = [...fills].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.row - b.row));
  const open = new Map<string, Episode>();
  const chargedOrders = new Set<string>();
  const done: Omit<Trade, 'id'>[] = [];

  const feeFor = (f: Fill, qty: number): { fee: number; estimated: boolean; missing: boolean } => {
    const share = qty / f.qty;
    if (f.fees !== null) return { fee: f.fees * share, estimated: false, missing: false };
    if (!opts.estimateFees) return { fee: 0, estimated: false, missing: true };
    const orderKey = f.orderId ? `${f.symbol}|${f.orderId}` : null;
    const first = orderKey === null || !chargedOrders.has(orderKey);
    if (orderKey) chargedOrders.add(orderKey);
    const kind = parseSymbol(f.symbol).kind;
    const full = estimateCharges({ kind, side: f.side, qty: f.qty, price: f.price, chargeBrokerage: first });
    return { fee: full * share, estimated: true, missing: false };
  };

  const apply = (ep: Episode, f: Fill, qty: number) => {
    const value = qty * f.price;
    if (f.side === 'BUY') {
      ep.buyValue += value;
      ep.pos += qty;
    } else {
      ep.sellValue += value;
      ep.pos -= qty;
    }
    ep.maxAbs = Math.max(ep.maxAbs, Math.abs(ep.pos));
    const fee = feeFor(f, qty);
    ep.fees += fee.fee;
    ep.feesEstimated ||= fee.estimated;
    ep.feesMissing ||= fee.missing;
    if (!ep.rows.includes(f.row)) ep.rows.push(f.row);
  };

  const close = (ep: Episode, exitTime: string) => {
    const info = parseSymbol(ep.symbol);
    const gross = round2(ep.sellValue - ep.buyValue);
    const fees = round2(ep.fees);
    const timed = hasClock(ep.entryTime) && hasClock(exitTime);
    done.push({
      symbol: ep.symbol,
      underlying: info.underlying,
      kind: info.kind,
      expiry: info.expiry,
      direction: ep.direction,
      qty: ep.maxAbs,
      entryTime: ep.entryTime,
      exitTime,
      holdMinutes: timed ? toMinutes(exitTime) - toMinutes(ep.entryTime) : null,
      grossPnl: gross,
      fees,
      feesSource: ep.feesMissing ? 'none' : ep.feesEstimated ? 'estimated' : 'reported',
      netPnl: round2(gross - fees),
      sourceRows: ep.rows,
    });
  };

  const start = (f: Fill): Episode => ({
    symbol: f.symbol,
    pos: 0,
    maxAbs: 0,
    direction: f.side === 'BUY' ? 'LONG' : 'SHORT',
    buyValue: 0,
    sellValue: 0,
    fees: 0,
    feesEstimated: false,
    feesMissing: false,
    rows: [],
    entryTime: f.time,
  });

  for (const f of ordered) {
    let ep = open.get(f.symbol);
    if (!ep) {
      ep = start(f);
      open.set(f.symbol, ep);
    }
    const signed = f.side === 'BUY' ? f.qty : -f.qty;
    const reducing = ep.pos !== 0 && Math.sign(signed) !== Math.sign(ep.pos);
    if (!reducing || Math.abs(signed) <= Math.abs(ep.pos)) {
      apply(ep, f, f.qty);
      if (ep.pos === 0) {
        close(ep, f.time);
        open.delete(f.symbol);
      }
      continue;
    }
    // Crosses zero: close what is open, carry the remainder into a new episode.
    const closingQty = Math.abs(ep.pos);
    apply(ep, f, closingQty);
    close(ep, f.time);
    const next = start(f);
    apply(next, f, f.qty - closingQty);
    open.set(f.symbol, next);
  }

  done.sort((a, b) => (a.entryTime! < b.entryTime! ? -1 : a.entryTime! > b.entryTime! ? 1 : 0));
  const width = String(done.length).length < 3 ? 3 : String(done.length).length;
  const trades = done.map((t, i) => ({ id: `T${String(i + 1).padStart(width, '0')}`, ...t }));
  const openPositions = [...open.values()].map((ep) => ({ symbol: ep.symbol, qty: ep.pos, sinceTime: ep.entryTime }));
  return { trades, openPositions };
}
