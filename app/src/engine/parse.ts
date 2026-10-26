import type { Detection, Fill, Note, ParseResult, RawTable, Side, Trade } from './types';
import { buildTrades } from './fills';
import { parseSymbol } from './symbols';
import { dateOf, hasClock, parseTime, toMinutes, weekday } from './time';
import { formatInr } from './format';

type Cell = string | number | null | undefined;

/** "₹1,23,456.50", "(450)", "-450", "450-" -> number. */
export function parseAmount(v: Cell): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = v.trim().replace(/^(rs\.?|inr)/i, '').replace(/[₹,\s]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  } else if (/^[0-9.]+-$/.test(s)) {
    neg = true;
    s = s.slice(0, -1);
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

function parseSide(v: Cell): Side | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (['BUY', 'B', 'BOUGHT', 'BUY TO OPEN', 'BUY TO CLOSE'].includes(s)) return 'BUY';
  if (['SELL', 'S', 'SOLD', 'SELL TO OPEN', 'SELL TO CLOSE'].includes(s)) return 'SELL';
  return null;
}

function cellText(v: Cell): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Execution time, combining a separate date column when the time cell has no date. */
function fillTime(timeCell: Cell, dateCell: Cell): string | null {
  const direct = parseTime(timeCell as string | number | null);
  const dateOnly = parseTime(dateCell as string | number | null);
  if (direct && (hasClock(direct) || !dateOnly)) return direct;
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(cellText(timeCell));
  if (clock && dateOnly) {
    return parseTime(`${dateOf(dateOnly)} ${clock[1].padStart(2, '0')}:${clock[2]}:${clock[3] ?? '00'}`);
  }
  return direct ?? dateOnly;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function parse(table: RawTable, detection: Detection): ParseResult {
  const { format, columns: c, headerRow } = detection;
  if (!format) throw new Error(detection.problems[0] ?? 'Could not recognise this file.');
  const get = (row: Cell[], idx: number | undefined): Cell => (idx === undefined || idx < 0 ? null : row[idx]);
  const rows = table.rows
    .map((r, i) => ({ r, n: i + 1 }))
    .slice(headerRow + 1)
    .filter(({ r }) => r.some((v) => cellText(v) !== ''));
  if (rows.length === 0) throw new Error('The file has a header but no trade rows.');

  const rejected: ParseResult['rejected'] = [];
  const notes: Note[] = [];
  let trades: Trade[] = [];
  let openPositions: ParseResult['openPositions'] = [];
  let quantity = true;

  if (format === 'fills') {
    for (const k of ['symbol', 'side', 'qty', 'price', 'time'] as const) {
      if (c[k] === undefined || c[k]! < 0) throw new Error(`Please match the ${k === 'qty' ? 'quantity' : k} column.`);
    }
    const fills: Fill[] = [];
    for (const { r, n } of rows) {
      const symbol = cellText(get(r, c.symbol)).toUpperCase();
      const side = parseSide(get(r, c.side));
      const qty = parseAmount(get(r, c.qty));
      const price = parseAmount(get(r, c.price));
      const time = fillTime(get(r, c.time), get(r, c.date));
      const feesCell = get(r, c.fees);
      const fees = c.fees !== undefined && c.fees >= 0 ? parseAmount(feesCell) : null;
      const reason = !symbol
        ? 'missing symbol'
        : !side
          ? `buy/sell value "${cellText(get(r, c.side))}" not recognised`
          : qty === null || qty <= 0
            ? 'quantity missing or not positive'
            : price === null || price < 0
              ? 'price missing or invalid'
              : !time
                ? 'date/time missing or unreadable'
                : cellText(feesCell) !== '' && fees === null
                  ? 'charges value unreadable'
                  : null;
      if (reason) {
        rejected.push({ row: n, reason });
        continue;
      }
      fills.push({
        row: n,
        symbol,
        side: side!,
        qty: Math.abs(qty!),
        price: price!,
        time: time!,
        fees: fees === null ? null : Math.abs(fees),
        orderId: cellText(get(r, c.orderId)) || null,
      });
    }
    const built = buildTrades(fills, { estimateFees: true });
    trades = built.trades;
    openPositions = built.openPositions;
  } else {
    if (c.symbol === undefined || c.pnl === undefined) throw new Error('Please match the symbol and profit/loss columns.');
    const hasFees = c.fees !== undefined && c.fees >= 0;
    const hasNet = c.netPnl !== undefined && c.netPnl >= 0;
    quantity = c.qty !== undefined && c.qty >= 0;
    const seen = new Set<string>();
    for (const { r, n } of rows) {
      const symbol = cellText(get(r, c.symbol)).toUpperCase();
      const pnl = parseAmount(get(r, c.pnl));
      const net = hasNet ? parseAmount(get(r, c.netPnl)) : null;
      const feesRaw = hasFees ? parseAmount(get(r, c.fees)) : null;
      const entryCell = cellText(get(r, c.entryTime));
      const exitCell = cellText(get(r, c.exitTime));
      const entry = entryCell ? parseTime(get(r, c.entryTime) as string | number) : null;
      const exit = exitCell ? parseTime(get(r, c.exitTime) as string | number) : null;
      const qtyRaw = quantity ? parseAmount(get(r, c.qty)) : null;
      const reason = !symbol
        ? 'missing symbol'
        : pnl === null
          ? `profit/loss value "${cellText(get(r, c.pnl))}" unreadable`
          : hasFees && cellText(get(r, c.fees)) !== '' && feesRaw === null
            ? 'charges value unreadable'
            : (entryCell && !entry) || (exitCell && !exit)
              ? 'entry/exit time unreadable'
              : entry && exit && toMinutes(exit) < toMinutes(entry)
                ? 'exit is before entry'
                : null;
      if (reason) {
        rejected.push({ row: n, reason });
        continue;
      }
      const fees = feesRaw === null ? null : Math.abs(feesRaw);
      let gross: number | null;
      let netPnl: number;
      let feesSource: Trade['feesSource'];
      if (hasNet && net !== null) {
        gross = pnl!;
        netPnl = net;
        feesSource = 'reported';
      } else if (detection.pnlIsNet) {
        netPnl = pnl!;
        gross = fees === null ? null : pnl! + fees;
        feesSource = fees === null ? 'included' : 'reported';
      } else {
        gross = pnl!;
        netPnl = fees === null ? pnl! : pnl! - fees;
        feesSource = fees === null ? 'none' : 'reported';
      }
      const info = parseSymbol(symbol);
      let id = cellText(get(r, c.tradeId)) || `R${n}`;
      if (seen.has(id)) id = `${id}#${n}`;
      seen.add(id);
      if (quantity && (qtyRaw === null || qtyRaw === 0)) quantity = false;
      trades.push({
        id,
        symbol,
        underlying: info.underlying,
        kind: info.kind,
        expiry: info.expiry,
        direction: qtyRaw !== null && qtyRaw < 0 ? 'SHORT' : 'UNKNOWN',
        qty: Math.abs(qtyRaw ?? 0),
        entryTime: entry,
        exitTime: exit,
        holdMinutes: entry && exit && hasClock(entry) && hasClock(exit) ? toMinutes(exit) - toMinutes(entry) : null,
        grossPnl: gross === null ? null : round2(gross),
        fees: round2(fees ?? (gross !== null ? gross - netPnl : 0)),
        feesSource,
        netPnl: round2(netPnl),
        sourceRows: [n],
      });
    }
    // Chronological when every trade has a time; otherwise keep file order.
    if (trades.every((t) => t.entryTime || t.exitTime)) {
      const key = (t: Trade) => (t.entryTime ?? t.exitTime)!;
      trades = trades.map((t, i) => ({ t, i })).sort((a, b) => (key(a.t) < key(b.t) ? -1 : key(a.t) > key(b.t) ? 1 : a.i - b.i)).map((x) => x.t);
    }
  }

  if (trades.length === 0) {
    const why = rejected[0] ? ` First problem: row ${rejected[0].row}, ${rejected[0].reason}.` : '';
    throw new Error(
      format === 'fills' && openPositions.length
        ? 'No buy/sell pair in this file closes a position, so there are no finished trades to review.'
        : `No valid trades were found.${why}`,
    );
  }

  // Coverage + notes
  const timestamps = trades.every((t) => hasClock(t.entryTime) && hasClock(t.exitTime));
  const sources = new Set(trades.map((t) => t.feesSource));
  const fees: ParseResult['coverage']['fees'] = sources.size === 1 ? [...sources][0] : 'mixed';

  if (rejected.length) {
    notes.push({ level: 'warn', text: `${rejected.length} row${rejected.length > 1 ? 's were' : ' was'} skipped because of missing or unreadable values.` });
  }
  if (fees === 'estimated' || (fees === 'mixed' && sources.has('estimated'))) {
    const total = trades.filter((t) => t.feesSource === 'estimated').reduce((s, t) => s + t.fees, 0);
    notes.push({
      level: 'info',
      text: `Your file has no charges column, so charges (${formatInr(total)}) were estimated from standard NSE rates: ₹20 brokerage per order, STT, exchange fees, GST and stamp duty. Your contract notes are the final word.`,
    });
  }
  if (fees === 'none') {
    notes.push({ level: 'warn', text: 'No charges column was found, so results are before charges. Your real results are a little worse.' });
  }
  if (fees === 'included') {
    notes.push({ level: 'info', text: 'Profit/loss was read as already after charges, so charges are not shown separately.' });
  }
  if (openPositions.length) {
    const list = openPositions.map((p) => `${p.symbol} (${p.qty > 0 ? '+' : ''}${p.qty})`).join(', ');
    notes.push({ level: 'info', text: `${openPositions.length} position${openPositions.length > 1 ? 's' : ''} still open at the end of the file ${openPositions.length > 1 ? 'were' : 'was'} left out: ${list}.` });
  }
  if (!timestamps) {
    notes.push({ level: 'info', text: 'Some trades have no entry/exit time, so checks that depend on timing were skipped.' });
  }
  const dates = trades.map((t) => t.entryTime ?? t.exitTime).filter((d): d is string => !!d).map(dateOf);
  const weekend = dates.filter((d) => [0, 6].includes(weekday(d))).length;
  if (weekend) {
    notes.push({ level: 'warn', text: `${weekend} trade${weekend > 1 ? 's are' : ' is'} dated on a Saturday or Sunday, when NSE is closed. If that's unexpected, check the date format (dates are read as day-month-year).` });
  }
  if (dates.length) {
    const span = (toMinutes(dates.reduce((a, b) => (a > b ? a : b))) - toMinutes(dates.reduce((a, b) => (a < b ? a : b)))) / 1440;
    if (span > 45) notes.push({ level: 'info', text: `This file covers about ${Math.round(span)} days. The review is built for about a month and treats it as one period.` });
  }

  return {
    format,
    trades,
    rejected,
    openPositions,
    notes,
    coverage: { timestamps, fees, quantity: format === 'fills' ? true : quantity },
  };
}
