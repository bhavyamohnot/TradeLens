import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Wordmark } from './parts';

interface Props {
  error: string | null;
  onFile: (file: File) => void;
  onSample: (path: string, fileName: string) => void;
}

export default function Landing({ error, onFile, onSample }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  return (
    <div className="landing">
      <header className="hero">
        <div className="wrap hero-inner">
          <Wordmark light />
          <h1>Find the 2–3 habits that cost you money last month.</h1>
          <p className="hero-sub">
            Upload a month of order history. You get back the few habits worth fixing, each with the ₹ it cost you and one rule to try.
          </p>

          <div
            className={`dropzone${over ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <button type="button" className="drop-btn" onClick={() => input.current?.click()}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="drop-title">Drop your file here, or click to choose</span>
              <span className="drop-hint">CSV, TSV, XLSX or XLS, up to 5 MB</span>
            </button>
            <input
              ref={input}
              type="file"
              accept=".csv,.tsv,.xlsx,.xls"
              hidden
              aria-label="Upload order history file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = '';
              }}
            />
          </div>

          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}

          <div className="samples">
            <span className="samples-label">No file handy? Try a sample.</span>
            <div className="sample-btns">
              <button type="button" className="btn btn-ghost-light" onClick={() => onSample('/samples/sept-2026-tradebook.csv', 'sept-2026-tradebook.csv')}>
                Sample: a month of F&amp;O order history
              </button>
              <button type="button" className="btn btn-ghost-light" onClick={() => onSample('/samples/tradelens-example.xlsx', 'tradelens-example.xlsx')}>
                Sample: closed-trade sheet
              </button>
            </div>
          </div>
          <p className="privacy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M8 11V8a4 4 0 118 0v3" stroke="currentColor" strokeWidth="2" />
            </svg>
            Your file never leaves this browser.
          </p>
        </div>
      </header>

      <main className="wrap landing-body">
        <section aria-labelledby="how">
          <h2 id="how" className="eyebrow">
            How it works
          </h2>
          <ol className="steps">
            <li>
              <span className="step-n">1</span>
              <div>
                <strong>Upload</strong>
                <p>Your broker's order history for a month.</p>
              </div>
            </li>
            <li>
              <span className="step-n">2</span>
              <div>
                <strong>We rebuild your trades</strong>
                <p>Buys and sells are matched into round-trip trades.</p>
              </div>
            </li>
            <li>
              <span className="step-n">3</span>
              <div>
                <strong>You get the habits</strong>
                <p>Ranked by how many rupees each one cost you.</p>
              </div>
            </li>
          </ol>
        </section>

        <details className="faq">
          <summary>What file do I need?</summary>
          <div className="faq-body">
            <p>Either of these works:</p>
            <ul>
              <li>
                <strong>A broker tradebook export.</strong> One row for each buy or sell. For example, in Zerodha: Console, Reports, Tradebook, then download as CSV or XLSX.
              </li>
              <li>
                <strong>A sheet with one row per closed trade.</strong> Each row has the symbol, entry and exit time, and the profit or loss.
              </li>
            </ul>
            <p>Not sure what yours looks like? Start from a template:</p>
            <p className="links">
              <a href="/samples/template-tradebook.csv" download>
                Download tradebook template (.csv)
              </a>
              <a href="/samples/template-closed-trades.csv" download>
                Download closed-trades template (.csv)
              </a>
            </p>
            <p className="muted">If we cannot tell which column is which, we will ask you to match them. It takes a few seconds.</p>
          </div>
        </details>
      </main>

      <footer className="wrap foot">
        TradeLens reviews past trades only. It is not investment advice. Not affiliated with any broker.
      </footer>
    </div>
  );
}
