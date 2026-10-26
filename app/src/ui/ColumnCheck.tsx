import { useMemo, useState } from 'react';
import { FIELD_LABELS, FORMAT_FIELDS } from '../engine';
import type { ColumnMap, Detection, FieldKey, InputFormat, RawTable } from '../engine';
import { Wordmark } from './parts';

interface Props {
  table: RawTable;
  initial: Detection;
  error: string | null;
  canPickSheet: boolean;
  onSheet: (sheet: string) => void;
  onAnalyse: (d: Detection) => void;
  onBack: () => void;
  backLabel?: string;
}

const FORMATS: { id: InputFormat; label: string }[] = [
  { id: 'fills', label: 'Order history — one row per buy/sell' },
  { id: 'closed-trades', label: 'Closed trades — one row per trade with P&L' },
];

function cell(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

export default function ColumnCheck({ table, initial, error, canPickSheet, onSheet, onAnalyse, onBack, backLabel = 'Back' }: Props) {
  const [format, setFormat] = useState<InputFormat>(initial.format ?? 'fills');
  const [columns, setColumns] = useState<ColumnMap>(initial.columns);
  const [pnlIsNet, setPnlIsNet] = useState(initial.pnlIsNet);

  const fields = FORMAT_FIELDS[format];
  const missing = fields.required.filter((f) => (columns[f] ?? -1) < 0);
  const headers = initial.headers;
  const preview = useMemo(() => table.rows.slice(initial.headerRow + 1, initial.headerRow + 6), [table, initial.headerRow]);
  const shownCols = headers.length > 0 ? headers.length : Math.max(0, ...preview.map((r) => r.length));

  const setCol = (f: FieldKey, v: number) => setColumns((c) => ({ ...c, [f]: v }));
  const mapped = new Set(Object.values(columns).filter((v): v is number => typeof v === 'number' && v >= 0));
  const colName = (i: number) => (headers[i] && headers[i].trim() ? headers[i] : `Column ${i + 1}`);

  const analyse = () =>
    onAnalyse({ ...initial, format, columns, pnlIsNet, confidence: 'high', problems: [] });

  const renderField = (f: FieldKey, required: boolean) => (
    <div className="map-row" key={f}>
      <label htmlFor={`map-${f}`}>
        {FIELD_LABELS[f]}
        {required ? <span className="req"> Required</span> : <span className="opt"> Optional</span>}
      </label>
      <select id={`map-${f}`} value={columns[f] ?? -1} onChange={(e) => setCol(f, Number(e.target.value))}>
        <option value={-1}>{required ? 'Choose a column' : 'Not in my file'}</option>
        {Array.from({ length: shownCols }, (_, i) => (
          <option key={i} value={i}>
            {colName(i)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="page">
      <div className="topbar no-print">
        <div className="wrap topbar-inner">
          <Wordmark />
        </div>
      </div>
      <main className="wrap narrow">
        <button type="button" className="link-btn" onClick={onBack}>
          ← {backLabel}
        </button>
        <h1 className="page-title">Check the columns</h1>
        <p className="lede">
          {initial.format === null || initial.confidence === 'low'
            ? 'We were not fully sure which column is which. Match them below and we will do the rest.'
            : 'Here is how we read your file. Change anything that looks wrong, then analyse again.'}{' '}
          File: <strong>{table.fileName}</strong>
        </p>

        {error && (
          <p className="error-box dark-on-light" role="alert">
            {error}
          </p>
        )}
        {initial.problems.length > 0 && (
          <ul className="problems" aria-label="What we noticed">
            {initial.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}

        {table.sheetNames.length > 1 && canPickSheet && (
          <div className="card block">
            <label htmlFor="sheet" className="block-title">
              Sheet
            </label>
            <select id="sheet" value={table.sheet ?? table.sheetNames[0]} onChange={(e) => onSheet(e.target.value)}>
              {table.sheetNames.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset className="card block">
          <legend className="block-title">What does each row in your file mean?</legend>
          {FORMATS.map((f) => (
            <label key={f.id} className={`radio${format === f.id ? ' on' : ''}`}>
              <input type="radio" name="format" checked={format === f.id} onChange={() => setFormat(f.id)} />
              <span>{f.label}</span>
            </label>
          ))}
        </fieldset>

        <section className="card block">
          <h2 className="block-title">Match your columns</h2>
          <div className="map-grid">
            {fields.required.map((f) => renderField(f, true))}
            {fields.optional.map((f) => renderField(f, false))}
          </div>
          {format === 'closed-trades' && (
            <fieldset className="pnl-toggle">
              <legend>Is the P&amp;L in your file before or after charges?</legend>
              <label className={`radio${!pnlIsNet ? ' on' : ''}`}>
                <input type="radio" name="pnlnet" checked={!pnlIsNet} onChange={() => setPnlIsNet(false)} />
                <span>Before charges (we will subtract charges)</span>
              </label>
              <label className={`radio${pnlIsNet ? ' on' : ''}`}>
                <input type="radio" name="pnlnet" checked={pnlIsNet} onChange={() => setPnlIsNet(true)} />
                <span>After charges (already net)</span>
              </label>
            </fieldset>
          )}
        </section>

        <section className="card block">
          <h2 className="block-title">Preview: first {preview.length} rows</h2>
          <div className="table-scroll">
            <table className="tbl preview">
              <thead>
                <tr>
                  {Array.from({ length: shownCols }, (_, i) => (
                    <th key={i} className={mapped.has(i) ? 'mapped' : ''}>
                      {colName(i)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((r, ri) => (
                  <tr key={ri}>
                    {Array.from({ length: shownCols }, (_, i) => (
                      <td key={i}>{cell(r[i])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="actions-row">
          <button type="button" className="btn btn-primary" disabled={missing.length > 0} onClick={analyse}>
            Analyse
          </button>
          {missing.length > 0 && <span className="muted">Still needed: {missing.map((f) => FIELD_LABELS[f]).join(', ')}</span>}
        </div>
      </main>
    </div>
  );
}
