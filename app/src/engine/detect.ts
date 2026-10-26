import type { ColumnMap, Detection, FieldKey, InputFormat, RawTable } from './types';

export const FIELD_LABELS: Record<FieldKey, string> = {
  symbol: 'Symbol / contract',
  side: 'Buy or sell',
  qty: 'Quantity',
  price: 'Price',
  time: 'Execution time',
  date: 'Trade date',
  fees: 'Charges / fees',
  orderId: 'Order ID',
  tradeId: 'Trade ID',
  entryTime: 'Entry time',
  exitTime: 'Exit time',
  pnl: 'Profit / loss',
  netPnl: 'Net profit / loss (after charges)',
  expiry: 'Expiry date',
};

export const FORMAT_FIELDS: Record<InputFormat, { required: FieldKey[]; optional: FieldKey[] }> = {
  fills: {
    required: ['symbol', 'side', 'qty', 'price', 'time'],
    optional: ['date', 'fees', 'orderId', 'tradeId', 'expiry'],
  },
  'closed-trades': {
    required: ['symbol', 'pnl'],
    optional: ['netPnl', 'fees', 'entryTime', 'exitTime', 'qty', 'tradeId', 'expiry'],
  },
};

// Normalised header aliases (lowercase, alphanumerics only), most specific first.
const ALIASES: Record<FieldKey, string[]> = {
  symbol: ['symbol', 'tradingsymbol', 'ticker', 'instrument', 'instrumentname', 'scrip', 'scripname', 'script', 'contract', 'security', 'securityname', 'stock', 'stockname'],
  side: ['tradetype', 'side', 'buysell', 'buyorsell', 'transactiontype', 'action', 'direction', 'bs', 'type'],
  qty: ['quantity', 'qty', 'filledqty', 'tradedqty', 'tradeqty', 'executedqty', 'filledquantity', 'tradedquantity', 'units', 'size'],
  price: ['price', 'tradeprice', 'tradedprice', 'executionprice', 'fillprice', 'avgprice', 'averageprice', 'rate', 'netrate'],
  time: ['orderexecutiontime', 'executiontime', 'tradetime', 'exchangetime', 'filltime', 'datetime', 'timestamp', 'time', 'ordertime', 'exchtime'],
  date: ['tradedate', 'date', 'orderdate', 'transactiondate'],
  fees: ['charges', 'totalcharges', 'fees', 'fee', 'brokerage', 'commission', 'transactioncharges', 'costs'],
  orderId: ['orderid', 'ordernumber', 'orderno', 'exchangeorderid'],
  tradeId: ['tradeid', 'tradeno', 'tradenumber', 'id'],
  entryTime: ['entrytime', 'entrydate', 'entrydatetime', 'opentime', 'opendate', 'buytime', 'buydate', 'entry'],
  exitTime: ['exittime', 'exitdate', 'exitdatetime', 'closetime', 'closedate', 'selltime', 'selldate', 'exit'],
  pnl: ['pnl', 'pl', 'profitloss', 'profit', 'grosspnl', 'grosspl', 'grossprofit', 'realizedpnl', 'realisedpnl', 'realizedpl', 'realisedpl', 'realizedprofit', 'realisedprofit'],
  netPnl: ['netpnl', 'netpl', 'netprofit', 'netprofitloss', 'netrealizedpnl', 'netrealisedpnl', 'netrealizedpl', 'netrealisedpl'],
  expiry: ['expiry', 'expirydate'],
};
const WEAK_ALIASES = new Set(['type', 'id', 'time', 'date', 'size', 'entry', 'exit', 'rate', 'profit']);

export const norm = (h: unknown) =>
  String(h ?? '')
    .replace(/﻿/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function mapHeaders(headers: string[]): { columns: ColumnMap; weak: FieldKey[] } {
  const normed = headers.map(norm);
  const used = new Set<number>();
  const columns: ColumnMap = {};
  const weak: FieldKey[] = [];
  for (const field of Object.keys(ALIASES) as FieldKey[]) {
    for (const alias of ALIASES[field]) {
      const idx = normed.findIndex((h, i) => h === alias && !used.has(i));
      if (idx >= 0) {
        columns[field] = idx;
        used.add(idx);
        if (WEAK_ALIASES.has(alias)) weak.push(field);
        break;
      }
    }
  }
  return { columns, weak };
}

/** Finds the row that looks most like a header. Exported so the reader can rank sheets. */
export function headerScore(rows: (string | number | null)[][]): { row: number; score: number } {
  let best = { row: 0, score: -1 };
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = rows[r].map((c) => (typeof c === 'string' ? c : ''));
    if (cells.filter(Boolean).length < 2) continue;
    const { columns } = mapHeaders(cells);
    const n = Object.keys(columns).length;
    const score = n + (columns.symbol !== undefined ? 3 : 0) + (columns.pnl !== undefined || columns.netPnl !== undefined || columns.price !== undefined ? 3 : 0);
    if (score > best.score) best = { row: r, score };
  }
  return best;
}

export function detect(table: RawTable): Detection {
  const problems: string[] = [];
  if (table.rows.length === 0) {
    return { headerRow: 0, headers: [], format: null, columns: {}, pnlIsNet: false, confidence: 'low', problems: ['The file is empty.'] };
  }
  const { row: headerRow } = headerScore(table.rows);
  const headers = (table.rows[headerRow] ?? []).map((c) => String(c ?? '').trim());
  const { columns, weak } = mapHeaders(headers);
  const has = (f: FieldKey) => columns[f] !== undefined;
  const dataRows = table.rows.length - headerRow - 1;

  // Prefer the dedicated net column when there is no gross one.
  if (!has('pnl') && has('netPnl')) {
    columns.pnl = columns.netPnl;
    delete columns.netPnl;
  }
  const pnlIsNet = has('pnl') && /net/i.test(headers[columns.pnl!] ?? '');

  let format: InputFormat | null = null;
  if (has('symbol') && has('pnl')) format = 'closed-trades';
  else if (has('symbol') && has('side') && has('qty') && has('price')) format = 'fills';

  if (format === 'fills' && !has('time') && has('date')) {
    columns.time = columns.date;
    problems.push('Only a trade date was found, so timing checks (re-entries, time of day) will be skipped.');
  }

  if (!has('symbol')) problems.push('No symbol / contract column was found.');
  if (!format) {
    if (has('side') && !has('price')) problems.push('Buy/sell rows need a price column to work out profit and loss.');
    else if (has('side') && !has('qty')) problems.push('Buy/sell rows need a quantity column.');
    else if (!has('pnl')) problems.push('No profit/loss column, and no buy/sell + quantity + price columns, were found.');
  }
  if (dataRows < 1) problems.push('The file has a header but no trade rows.');

  const required = format ? FORMAT_FIELDS[format].required : [];
  const missingRequired = required.filter((f) => !has(f) && !(format === 'closed-trades' && f === 'time'));
  const confidence: Detection['confidence'] =
    format && missingRequired.length === 0 && dataRows >= 1 && !weak.some((f) => required.includes(f)) ? 'high' : 'low';
  if (format && missingRequired.length) {
    problems.push(`Please match: ${missingRequired.map((f) => FIELD_LABELS[f]).join(', ')}.`);
  }

  return { headerRow, headers, format, columns, pnlIsNet, confidence, problems };
}
