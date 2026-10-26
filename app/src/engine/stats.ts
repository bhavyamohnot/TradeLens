export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}

/**
 * Welch's t statistic for mean(a) − mean(b). Negative = a is worse.
 * Returns null when either side is too small to say anything.
 */
export function welchT(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  const diff = mean(a) - mean(b);
  if (se === 0) return diff === 0 ? 0 : diff < 0 ? -Infinity : Infinity;
  return diff / se;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round0 = (n: number) => Math.round(n);
