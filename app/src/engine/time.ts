// Timestamps are kept as exchange-local wall-clock strings. Minute arithmetic
// goes through Date.UTC so the viewer's time zone never shifts anything.

const pad = (n: number) => String(n).padStart(2, '0');

function valid(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    y >= 1990 &&
    y <= 2100 &&
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d &&
    h < 24 &&
    mi < 60 &&
    s < 60
  );
}

function build(y: number, mo: number, d: number, time?: [number, number, number]): string | null {
  if (!time) return valid(y, mo, d, 0, 0, 0) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  const [h, mi, s] = time;
  return valid(y, mo, d, h, mi, s) ? `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}` : null;
}

/** Excel serial date (1900 system) -> local ISO. */
function fromExcelSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const ms = Math.round((serial - 25569) * 86400) * 1000; // whole seconds: avoids 09:29:59.997
  const dt = new Date(ms);
  const hasTime = serial % 1 !== 0;
  return build(
    dt.getUTCFullYear(),
    dt.getUTCMonth() + 1,
    dt.getUTCDate(),
    hasTime ? [dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds()] : undefined,
  );
}

const TIME_PART = /(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Accepts YYYY-MM-DD[ HH:mm[:ss]], ISO with T (offset ignored: treated as local),
 * DD-MM-YYYY / DD/MM/YYYY [HH:mm[:ss]] and Excel serials.
 * Returns "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD" for date-only input, or null.
 */
export function parseTime(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return fromExcelSerial(value);
  const v = value.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n > 20000 && n < 80000 ? fromExcelSerial(n) : null;
  }
  const ymd = new RegExp(`^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})${TIME_PART.source}`, 'i').exec(v);
  const dmy = new RegExp(`^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})${TIME_PART.source}`, 'i').exec(v);
  const m = ymd ?? dmy;
  if (!m) return null;
  const [y, mo, d] = ymd ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]];
  if (m[4] === undefined) return build(y, mo, d);
  let h = +m[4];
  const ampm = m[7]?.toUpperCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === 'PM' ? 12 : 0);
  }
  return build(y, mo, d, [h, +m[5], m[6] ? +m[6] : 0]);
}

export const hasClock = (t: string | null): t is string => !!t && t.length >= 16;

/** Minutes since epoch for a local ISO string (date-only = midnight). */
export function toMinutes(t: string): number {
  const [d, time = '00:00:00'] = t.split('T');
  const [y, mo, day] = d.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  return Date.UTC(y, mo - 1, day, h, mi, s || 0) / 60000;
}

export const dateOf = (t: string) => t.slice(0, 10);

/** Minutes after midnight, e.g. 09:15 -> 555. */
export const minuteOfDay = (t: string) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** Last given weekday (0=Sun..6=Sat) of a month, as YYYY-MM-DD. */
export function lastWeekdayOfMonth(year: number, month: number, dow: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const back = (last.getUTCDay() - dow + 7) % 7;
  return `${year}-${pad(month)}-${pad(last.getUTCDate() - back)}`;
}
