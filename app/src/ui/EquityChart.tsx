import { useEffect, useRef, useState } from 'react';
import { formatDate, formatSignedInr } from '../engine';
import type { Review } from '../engine';

const H = 220;
const PAD = { l: 8, r: 12, t: 14, b: 26 };
const SERIES_STYLE = [
  { color: '#0F8A4B', dash: '6 4' },
  { color: '#0E9AA7', dash: '2 4' },
  { color: '#7C5CD6', dash: '8 3 2 3' },
];

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(260, Math.floor(el.clientWidth)));
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function EquityChart({ review }: { review: Review }) {
  const [ref, W] = useWidth();
  const eq = review.equity;
  const nSeries = Math.min(review.habits.length, 3);
  if (eq.length < 2) return null;

  const series: { label: string; color: string; dash?: string; width: number; values: number[] }[] = [
    { label: 'What happened', color: '#1D6FE8', width: 2.6, values: eq.map((e) => e.actual) },
  ];
  for (let i = 0; i < nSeries; i++) {
    series.push({
      label: i === 0 ? 'Without habit #1' : `Without habits #1–#${i + 1}`,
      color: SERIES_STYLE[i].color,
      dash: SERIES_STYLE[i].dash,
      width: 2,
      values: eq.map((e) => e.withoutHabits[i] ?? e.actual),
    });
  }

  const all = [0, ...series.flatMap((s) => s.values)];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1) {
    hi += 1;
    lo -= 1;
  }
  const span = hi - lo;
  lo -= span * 0.06;
  hi += span * 0.06;
  const x = (i: number) => PAD.l + (i / (eq.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * (H - PAD.t - PAD.b);
  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const last = (s: { values: number[] }) => s.values[s.values.length - 1];
  const first = review.trades[0]?.entryTime ?? eq[0].time;
  const lastT = review.trades[review.trades.length - 1]?.exitTime ?? eq[eq.length - 1].time;
  const aria =
    `Line chart of cumulative net P&L across ${eq.length} trades. You ended at ${formatSignedInr(last(series[0]))}.` +
    series
      .slice(1)
      .map((s) => ` ${s.label}: ${formatSignedInr(last(s))}.`)
      .join('');

  return (
    <div className="chart" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#94A3B8" strokeWidth="1" />
        <text x={PAD.l + 2} y={y(0) - 5} className="chart-t">
          ₹0
        </text>
        {series
          .slice()
          .reverse()
          .map((s) => (
            <path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
          ))}
        {series.map((s) => (
          <circle key={s.label} cx={x(eq.length - 1)} cy={y(last(s))} r={3.5} fill={s.color} />
        ))}
        <text x={PAD.l} y={H - 7} className="chart-t">
          {first ? formatDate(first) : 'Start'}
        </text>
        <text x={W - PAD.r} y={H - 7} textAnchor="end" className="chart-t">
          {lastT ? formatDate(lastT) : 'End'}
        </text>
      </svg>
      <ul className="legend">
        {series.map((s) => (
          <li key={s.label}>
            <svg width="26" height="8" aria-hidden="true">
              <line x1="1" x2="25" y1="4" y2="4" stroke={s.color} strokeWidth="2.4" strokeDasharray={s.dash} strokeLinecap="round" />
            </svg>
            <span>{s.label}</span>
            <strong className={last(s) < 0 ? 'neg' : 'pos'}>{formatSignedInr(last(s))}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
