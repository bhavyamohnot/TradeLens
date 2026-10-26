import type { Cleared, Commitment, Review } from '../engine';

export const COMMITMENT_KEY = 'tradelens.commitment.v1';

export function loadCommitment(): Commitment | null {
  try {
    const raw = localStorage.getItem(COMMITMENT_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Commitment;
    return c && typeof c.key === 'string' && typeof c.baselinePeriod === 'string' ? c : null;
  } catch {
    return null;
  }
}

export function saveCommitment(c: Commitment | null): void {
  try {
    if (c) localStorage.setItem(COMMITMENT_KEY, JSON.stringify(c));
    else localStorage.removeItem(COMMITMENT_KEY);
  } catch {
    /* storage unavailable (private mode): the commitment simply is not remembered */
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

export function formatHold(mins: number | null): string {
  if (mins === null || mins === undefined) return '—';
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h >= 24) return `${Math.round(h / 24)} d`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "time-window:closing" -> "Time window (closing)" */
export function humanizeKey(key: string): string {
  const [base, variant] = key.split(':');
  const words = base.replace(/-/g, ' ');
  const cap = words.charAt(0).toUpperCase() + words.slice(1);
  return variant ? `${cap} (${variant})` : cap;
}

export function alsoExplains(keys: string[], cleared: Cleared[]): string {
  return keys
    .map((k) => cleared.find((c) => c.key === k)?.title ?? humanizeKey(k))
    .join(', ');
}

export function confidenceHelp(): string {
  return 'How sure we are, based on how many trades and how consistent the pattern is.';
}

export function trendWords(review: Review): string {
  return review.summary.netPnl < 0 ? 'net loss' : 'net profit';
}

export function downloadText(fileName: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-') || 'review';
}
