import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { RawTable } from './types';
import { parseTime } from './time';
import { headerScore } from './detect';

const MAX_ROWS = 50_000;
type Cell = string | number | null;

function decodeText(data: ArrayBuffer | Uint8Array | string): string {
  const text = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data);
  return text.replace(/^﻿/, '');
}

function readDelimited(text: string): Cell[][] {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const delimiter = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : '';
  const out = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: 'greedy' });
  if (out.errors.some((e) => e.type === 'Quotes')) {
    throw new Error('The CSV has an unclosed quote. Re-export it from your broker and try again.');
  }
  return out.data.slice(0, MAX_ROWS).map((r) => r.map((c) => (c === '' ? null : c)));
}

function sheetRows(ws: XLSX.WorkSheet, date1904: boolean): Cell[][] {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  range.e.r = Math.min(range.e.r, MAX_ROWS);
  range.e.c = Math.min(range.e.c, 60);
  const rows: Cell[][] = [];
  for (let r = 0; r <= range.e.r; r++) {
    const row: Cell[] = [];
    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      if (!cell || cell.v === undefined || cell.v === null || cell.v === '') {
        row.push(null);
      } else if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(String(cell.z))) {
        row.push(parseTime((cell.v as number) + (date1904 ? 1462 : 0)) ?? (cell.v as number));
      } else if (cell.t === 'n') {
        row.push(cell.v as number);
      } else if (cell.t === 'b') {
        row.push(cell.v ? 'TRUE' : 'FALSE');
      } else {
        row.push(String(cell.v));
      }
    }
    while (row.length && row[row.length - 1] === null) row.pop();
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

/** Reads CSV/TSV/XLSX/XLS into a raw grid. Picks the sheet that looks most like a trade list. */
export function readTable(data: ArrayBuffer | Uint8Array | string, fileName: string, sheet?: string): RawTable {
  const isSheet = /\.(xlsx|xlsm|xls|ods)$/i.test(fileName) && typeof data !== 'string';
  if (!isSheet) {
    const rows = readDelimited(decodeText(data));
    return { fileName, sheetNames: [], sheet: null, rows };
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, { type: 'array', cellNF: true, cellDates: false, sheetRows: MAX_ROWS + 1 });
  } catch {
    throw new Error('This workbook could not be opened. Save it as a normal .xlsx or CSV and try again.');
  }
  const date1904 = !!wb.Workbook?.WBProps?.date1904;
  const all = wb.SheetNames.map((name) => ({ name, rows: sheetRows(wb.Sheets[name], date1904) }));
  const chosen =
    all.find((s) => s.name === sheet) ??
    [...all].sort((a, b) => headerScore(b.rows).score - headerScore(a.rows).score)[0];
  if (!chosen || chosen.rows.length === 0) throw new Error('This workbook has no data.');
  return { fileName, sheetNames: wb.SheetNames, sheet: chosen.name, rows: chosen.rows };
}
