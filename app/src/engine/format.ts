const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ₹12,34,567 (Indian grouping). Negative values get a true minus sign. */
export function formatInr(n: number, opts: { decimals?: number } = {}): string {
  const decimals = opts.decimals ?? (Math.abs(n) < 100 && n % 1 !== 0 ? 2 : 0);
  const abs = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${n < 0 ? '−' : ''}₹${abs}`;
}

/** +₹650 / −₹9,100 */
export function formatSignedInr(n: number): string {
  return n > 0 ? `+${formatInr(n)}` : formatInr(n);
}

/** "2026-09-02" -> "2 Sep 2026" */
export function formatDate(date: string | null): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-09-02T09:15:00" -> "2 Sep, 09:15" */
export function formatDateTime(time: string | null): string {
  if (!time) return '—';
  const [, m, d] = time.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}, ${time.slice(11, 16) || '—'}`;
}
