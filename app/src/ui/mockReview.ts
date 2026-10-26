// Hand-built Review used to develop the UI without the engine (open /?mock=1).
// Typed against the engine contract; not used in the real upload flow.
import type { Cleared, EquityPoint, Habit, Review, Summary, Trade, Unavailable } from '../engine/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DAYS = [1, 2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21, 22, 23];
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (day: number, mins: number) => `2026-09-${pad(day)}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;

function buildTrades(): Trade[] {
  const r = rng(42);
  const out: Trade[] = [];
  let n = 0;
  for (const day of DAYS) {
    const perDay = 2 + Math.floor(r() * 2);
    let clock = 9 * 60 + 20 + Math.floor(r() * 40);
    for (let k = 0; k < perDay && n < 42; k++) {
      const u = r();
      const underlying = u < 0.36 ? 'BANKNIFTY' : u < 0.82 ? 'NIFTY' : 'RELIANCE';
      const isOpt = underlying !== 'RELIANCE';
      const type = r() < 0.5 ? 'CE' : 'PE';
      const strike = underlying === 'BANKNIFTY' ? 50000 + Math.round(r() * 6) * 100 : 24500 + Math.round(r() * 6) * 50;
      const symbol = isOpt ? `${underlying}26909${strike}${type}` : 'RELIANCE';
      const lot = underlying === 'BANKNIFTY' ? 30 : underlying === 'NIFTY' ? 75 : 50;
      const qty = lot * (1 + Math.floor(r() * 2));
      if (k === perDay - 1 && r() < 0.5) clock = Math.max(clock, 14 * 60 + 48);
      const hold = 3 + Math.floor(r() * 70);
      const mean = underlying === 'BANKNIFTY' ? -2300 : underlying === 'NIFTY' ? 100 : 80;
      const sd = underlying === 'BANKNIFTY' ? 2600 : underlying === 'NIFTY' ? 1700 : 700;
      const z = (r() + r() + r() - 1.5) * 2;
      const net = Math.round((mean + z * sd) / 5) * 5;
      const fees = Math.round(28 + r() * 40);
      n++;
      out.push({
        id: `t${n}`,
        symbol,
        underlying,
        kind: isOpt ? 'OPTION' : 'EQUITY',
        expiry: isOpt ? '2026-09-09' : null,
        direction: 'LONG',
        qty,
        entryTime: stamp(day, clock),
        exitTime: stamp(day, clock + hold),
        holdMinutes: hold,
        grossPnl: net + fees,
        fees,
        feesSource: 'reported',
        netPnl: net,
        sourceRows: [n * 2, n * 2 + 1],
      });
      clock += hold + 8 + Math.floor(r() * 55);
      if (clock > 15 * 60 + 10) break;
    }
  }
  return out;
}

const trades = buildTrades();
const mins = (t: string | null) => (t ? Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) : 0);

const h1Ids = trades.filter((t) => t.underlying === 'BANKNIFTY').map((t) => t.id);
const taken = new Set(h1Ids);
const h2Ids: string[] = [];
trades.forEach((t, i) => {
  if (taken.has(t.id) || i === 0) return;
  const p = trades[i - 1];
  const sameDay = p.entryTime?.slice(0, 10) === t.entryTime?.slice(0, 10);
  if (sameDay && p.netPnl < 0 && mins(t.entryTime) - mins(p.exitTime) <= 45 && t.netPnl < 0) h2Ids.push(t.id);
});
h2Ids.forEach((id) => taken.add(id));
const h3Ids = trades.filter((t) => !taken.has(t.id) && mins(t.entryTime) >= 14 * 60 + 45 && t.netPnl < 0).map((t) => t.id);

const byId = new Map(trades.map((t) => [t.id, t]));
const sum = (ids: string[]) => ids.reduce((a, id) => a + (byId.get(id)?.netPnl ?? 0), 0);
const adj = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, -(byId.get(id)?.netPnl ?? 0)]));

const habits: Habit[] = [
  {
    key: 'instrument-bleed:BANKNIFTY',
    id: 'instrument-bleed',
    rank: 1,
    title: 'Bank Nifty options keep losing money',
    summary: `Your ${h1Ids.length} Bank Nifty trades lost ${Math.abs(sum(h1Ids)).toLocaleString('en-IN')} rupees, while everything else you traded made money.`,
    cost: Math.max(0, -sum(h1Ids)),
    standaloneCost: Math.max(0, -sum(h1Ids)),
    tradeIds: h1Ids,
    evidence: [
      `${h1Ids.filter((id) => (byId.get(id)?.netPnl ?? 0) < 0).length} of ${h1Ids.length} Bank Nifty trades ended in a loss.`,
      'Your Nifty and Reliance trades together were profitable over the same days.',
      'Losses on Bank Nifty were larger than gains on the trades that worked.',
    ],
    rule: 'Skip Bank Nifty for the next month, or cap it at one trade a day with a fixed stop-loss.',
    confidence: 'high',
    overlapsWith: ['time-window:closing'],
    adjustments: adj(h1Ids),
  },
  {
    key: 'quick-reentry',
    id: 'quick-reentry',
    rank: 2,
    title: 'Jumping back in within 45 minutes of a loss',
    summary: `${h2Ids.length} trades started within 45 minutes of a losing trade, and they lost another ${Math.abs(sum(h2Ids)).toLocaleString('en-IN')} rupees.`,
    cost: Math.max(0, -sum(h2Ids)),
    standaloneCost: Math.max(0, -sum(h2Ids)) + 1200,
    tradeIds: h2Ids,
    evidence: [
      `Every one of these ${h2Ids.length} trades was a loss.`,
      'The median gap after the previous loss was under 30 minutes.',
    ],
    rule: 'After a losing trade, wait an hour before opening the next one.',
    confidence: 'medium',
    overlapsWith: [],
    adjustments: adj(h2Ids),
  },
  {
    key: 'time-window:closing',
    id: 'time-window',
    rank: 3,
    title: 'Late-session trades after 2:45 pm',
    summary: `Trades opened in the last 45 minutes lost ${Math.abs(sum(h3Ids)).toLocaleString('en-IN')} rupees outside the two habits above.`,
    cost: Math.max(0, -sum(h3Ids)),
    standaloneCost: Math.max(0, -sum(h3Ids)) + 2400,
    tradeIds: h3Ids,
    evidence: [`${h3Ids.length} late-session trades lost money.`, 'Morning trades were net positive.'],
    rule: 'No new trades after 2:45 pm.',
    confidence: 'low',
    overlapsWith: [],
    adjustments: adj(h3Ids),
  },
].filter((h) => h.tradeIds.length > 0).sort((a, b) => b.cost - a.cost) as Habit[];
habits.forEach((h, i) => (h.rank = i + 1));

let run = 0;
const running = habits.map(() => 0);
const equity: EquityPoint[] = trades.map((t) => {
  run += t.netPnl;
  const withoutHabits = habits.map((_, i) => {
    let add = 0;
    for (let j = 0; j <= i; j++) add += habits[j].adjustments[t.id] ?? 0;
    running[i] += add;
    return run + running[i];
  });
  return { tradeId: t.id, time: t.exitTime, actual: run, withoutHabits };
});

const wins = trades.filter((t) => t.netPnl > 0);
const losses = trades.filter((t) => t.netPnl <= 0);
const byDay = new Map<string, number>();
trades.forEach((t) => byDay.set(t.entryTime!.slice(0, 10), (byDay.get(t.entryTime!.slice(0, 10)) ?? 0) + t.netPnl));
const dayList = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
let peak = 0;
let maxDd = 0;
equity.forEach((e) => {
  peak = Math.max(peak, e.actual);
  maxDd = Math.max(maxDd, peak - e.actual);
});
let streak = 0;
let longest = 0;
trades.forEach((t) => {
  streak = t.netPnl < 0 ? streak + 1 : 0;
  longest = Math.max(longest, streak);
});
const netPnl = trades.reduce((a, t) => a + t.netPnl, 0);
const fees = trades.reduce((a, t) => a + t.fees, 0);

const summary: Summary = {
  from: '2026-09-01',
  to: '2026-09-23',
  periodLabel: 'September 2026',
  trades: trades.length,
  tradingDays: byDay.size,
  wins: wins.length,
  losses: losses.length,
  winRate: Math.round((wins.length / trades.length) * 1000) / 10,
  grossPnl: netPnl + fees,
  fees,
  netPnl,
  avgWin: Math.round(wins.reduce((a, t) => a + t.netPnl, 0) / Math.max(1, wins.length)),
  avgLoss: Math.round(losses.reduce((a, t) => a + t.netPnl, 0) / Math.max(1, losses.length)),
  maxDrawdown: maxDd,
  bestDay: { date: dayList[0][0], netPnl: dayList[0][1] },
  worstDay: { date: dayList[dayList.length - 1][0], netPnl: dayList[dayList.length - 1][1] },
  longestLosingStreak: longest,
};

const cleared: Cleared[] = [
  { key: 'expiry-day', id: 'expiry-day', title: 'Trading on expiry day', detail: 'Your expiry-day trades made money overall, so there is nothing to fix here.', reason: 'profitable' },
  { key: 'size-after-loss', id: 'size-after-loss', title: 'Betting bigger after a loss', detail: 'Trades after a loss were not larger than your usual size, and they were net profitable.', reason: 'profitable' },
  { key: 'overtrading', id: 'overtrading', title: 'Too many trades in one day', detail: 'Your busiest days were not your worst days.', reason: 'not-found' },
  { key: 'fee-churn', id: 'fee-churn', title: 'Charges eating your profit', detail: 'Charges were a small share of your gross P&L.', reason: 'too-small' },
];
const unavailable: Unavailable[] = [
  { id: 'holding-losers', title: 'Holding losing trades too long', reason: 'Needs both entry and exit times for every trade, and this file has some missing.' },
];

export const mockReview: Review = {
  summary,
  verdict: `You made ${netPnl < 0 ? 'a net loss' : 'a net profit'} of ${Math.abs(netPnl).toLocaleString('en-IN')} rupees in September, and one instrument explains most of it.`,
  habits,
  cleared,
  unavailable,
  equity,
  notes: [
    { level: 'info', text: 'Round trips were rebuilt from individual buy and sell rows.' },
    { level: 'warn', text: 'Charges were estimated for 6 trades because the file had no charges column.' },
  ],
  trades,
};
