import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

export function Wordmark({ light = false }: { light?: boolean }) {
  return (
    <div className={`wordmark${light ? ' light' : ''}`}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill={light ? '#1D6FE8' : '#0A1630'} />
        <circle cx="14" cy="14" r="6.5" fill="none" stroke="#fff" strokeWidth="2.6" />
        <path d="M19 19l6 6" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
      <span>TradeLens</span>
    </div>
  );
}

/** When true (printing), collapsible sections render open. */
export const PrintContext = createContext(false);

export function Disclosure({ label, children, defaultOpen = false, className = '' }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const printing = useContext(PrintContext);
  const shown = open || printing;
  return (
    <div className={`disc ${className}`}>
      <button type="button" className="disc-btn" aria-expanded={shown} onClick={() => setOpen(!open)}>
        <svg className={`chev${shown ? ' open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </button>
      {shown && <div className="disc-body">{children}</div>}
    </div>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="tip">
      <button type="button" className="tip-btn" aria-label={text}>
        ?
      </button>
      <span className="tip-body" role="tooltip">
        {text}
      </span>
    </span>
  );
}
