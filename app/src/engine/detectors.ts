// Habit detectors. Each one turns the month's trades into zero or more
// candidates: a set of trades plus, per trade, the ₹ that fixing the habit
// would have saved ("delta"). analyze.ts ranks candidates by marginal cost.

import type { HabitId, Trade } from './types';
import { formatInr, formatSignedInr } from './format';
import { dateOf, hasClock, minuteOfDay, toMinutes } from './time';
import { mean, median, sum } from './stats';

export interface Ctx {
  trades: Trade[]; // chronological
  byId: Map<string, Trade>;
  timed: boolean;
  hasQty: boolean;
  feesKnown: boolean;
  totalNet: number;
  days: Map<string, Trade[]>; // by entry date, each sorted by entry time
}

export interface HabitText {
  title: string;
  summary: string;
  evidence: string[];
  rule: string;
}

export interface Candidate {
  key: string;
  id: HabitId;
  label: string; // short noun phrase for cross-references, e.g. "BANKNIFTY trades"
  type: 'set' | 'excess';
  multi: boolean; // one of several variants tested (stricter significance bar)
  tradeIds: string[];
  deltas: Record<string, number>;
  eligible: boolean; // detector-specific preconditions met (excess-type only)
  strength: 'strong' | 'moderate' | 'weak';
  text(args: { cost: number; trades: Trade[]; ctx: Ctx }): HabitText;
  /** Shown in "checked" when these trades made money overall. */
  profitableText(net: number, n: number): string;
}

export interface Detector {
  id: HabitId;
  name: string; // for "checked"/"couldn't check" lists
  unavailable(ctx: Ctx): string | null;
  run(ctx: Ctx): Candidate[];
  notFound(ctx: Ctx): string;
}

const net = (ts: Trade[]) => sum(ts.map((t) => t.netPnl));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const wins = (ts: Trade[]) => ts.filter((t) => t.netPnl > 0).length;
const setDeltas = (ts: Trade[]) => Object.fromEntries(ts.map((t) => [t.id, -t.netPnl]));
const strengthOf = (n: number): Candidate['strength'] => (n >= 10 ? 'strong' : n >= 5 ? 'moderate' : 'weak');
const NEEDS_TIME = 'Needs an entry and exit time for every trade.';

function longestLosingRun(ts: Trade[]): number {
  let best = 0;
  let run = 0;
  for (const t of ts) {
    run = t.netPnl < 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Closed trades of the same day that exited at or before `t` entered, latest first. */
function closedBefore(t: Trade, day: Trade[]): Trade[] {
  const at = toMinutes(t.entryTime!);
  return day
    .filter((p) => p !== t && p.exitTime && toMinutes(p.exitTime) <= at)
    .sort((a, b) => toMinutes(b.exitTime!) - toMinutes(a.exitTime!));
}

// ---------------------------------------------------------------------------

const instrumentBleed: Detector = {
  id: 'instrument-bleed',
  name: 'Instruments you trade',
  unavailable: () => null,
  run(ctx) {
    const groups = new Map<string, Trade[]>();
    for (const t of ctx.trades) groups.set(t.underlying, [...(groups.get(t.underlying) ?? []), t]);
    if (groups.size < 2) return [];
    return [...groups].map(([u, ts]) => ({
      key: `instrument-bleed:${u}`,
      id: 'instrument-bleed',
      label: `${u} trades`,
      type: 'set',
      multi: true,
      tradeIds: ts.map((t) => t.id),
      deltas: setDeltas(ts),
      eligible: ts.length >= 5,
      strength: strengthOf(ts.length),
      text: ({ cost, trades }) => {
        const all = groups.get(u)!;
        const rest = ctx.trades.filter((t) => t.underlying !== u);
        return {
          title: `${u} kept losing, and you kept trading it`,
          summary: `${u} cost you ${formatInr(cost)} over ${plural(trades.length, 'trade')}, with ${plural(wins(trades), 'win')}.`,
          evidence: [
            `${plural(all.length, `${u} trade`)}: ${wins(all)} won, ${all.length - wins(all)} lost, net ${formatSignedInr(net(all))}`,
            `Longest losing run in ${u}: ${plural(longestLosingRun(all), 'trade')} in a row`,
            `Everything else you traded: ${formatSignedInr(net(rest))} over ${plural(rest.length, 'trade')}`,
          ],
          rule: `After 3 losses in a row on ${u}, stop trading it until the next week.`,
        };
      },
      profitableText: (n, k) => `${u}: ${formatSignedInr(n)} over ${plural(k, 'trade')}.`,
    }));
  },
  notFound: () => 'No single instrument lost money consistently.',
};

const lossStreak: Detector = {
  id: 'loss-streak',
  name: 'Trading on after 3 straight losses',
  unavailable: (ctx) => (ctx.timed ? null : NEEDS_TIME),
  run(ctx) {
    const hits: Trade[] = [];
    for (const day of ctx.days.values()) {
      for (const t of day) {
        let run = 0;
        for (const p of closedBefore(t, day)) {
          if (p.netPnl < 0) run++;
          else break;
        }
        if (run >= 3) hits.push(t);
      }
    }
    if (!hits.length) return [];
    const days = new Set(hits.map((t) => dateOf(t.entryTime!))).size;
    return [
      {
        key: 'loss-streak',
        id: 'loss-streak',
        label: 'trades after 3 straight losses',
        type: 'set',
        multi: false,
        tradeIds: hits.map((t) => t.id),
        deltas: setDeltas(hits),
        eligible: true,
        strength: strengthOf(hits.length),
        text: ({ cost, trades }) => ({
          title: 'You kept trading after 3 losses in a row',
          summary: `Trades you took after 3 straight losses on the same day cost you ${formatInr(cost)}.`,
          evidence: [
            `${plural(trades.length, 'trade')} on ${plural(days, 'day')} came after 3 or more losses in a row`,
            `Those trades won ${wins(trades)} of ${trades.length} times, net ${formatSignedInr(net(trades))}`,
          ],
          rule: 'After 3 losing trades in a row, stop for the day.',
        }),
        profitableText: (n, k) =>
          `You traded on after 3 straight losses ${plural(k, 'time')}; those trades made ${formatSignedInr(n)}.`,
      },
    ];
  },
  notFound: () => 'You never had more than 2 losses in a row on the same day before trading again.',
};

const REENTRY_MIN = 15;
const quickReentry: Detector = {
  id: 'quick-reentry',
  name: 'Re-entering soon after a loss',
  unavailable: (ctx) => (ctx.timed ? null : NEEDS_TIME),
  run(ctx) {
    const hits: { t: Trade; gap: number }[] = [];
    for (const day of ctx.days.values()) {
      for (const t of day) {
        const at = toMinutes(t.entryTime!);
        const prior = day
          .filter((p) => p !== t && p.underlying === t.underlying && p.netPnl < 0 && p.exitTime)
          .map((p) => at - toMinutes(p.exitTime!))
          .filter((gap) => gap > 0 && gap <= REENTRY_MIN);
        if (prior.length) hits.push({ t, gap: Math.min(...prior) });
      }
    }
    if (!hits.length) return [];
    const ts = hits.map((h) => h.t);
    return [
      {
        key: 'quick-reentry',
        id: 'quick-reentry',
        label: 'quick re-entries after a loss',
        type: 'set',
        multi: false,
        tradeIds: ts.map((t) => t.id),
        deltas: setDeltas(ts),
        eligible: true,
        strength: strengthOf(ts.length),
        text: ({ cost, trades }) => {
          const others = ctx.trades.filter((t) => !ts.includes(t));
          return {
            title: 'Jumping back in right after a loss',
            summary: `Trades you re-entered within ${REENTRY_MIN} minutes of a loss in the same instrument cost you ${formatInr(cost)}.`,
            evidence: [
              `${plural(trades.length, 'time')}, typically ${Math.round(median(hits.map((h) => h.gap)))} minutes after the losing exit`,
              `Re-entries won ${wins(trades)} of ${trades.length} (${Math.round((wins(trades) / trades.length) * 100)}%); your other trades won ${Math.round((wins(others) / Math.max(others.length, 1)) * 100)}%`,
              `Average re-entry: ${formatSignedInr(mean(trades.map((t) => t.netPnl)))} vs ${formatSignedInr(mean(others.map((t) => t.netPnl)))} for other trades`,
            ],
            rule: 'After a loss, wait 30 minutes before trading that instrument again.',
          };
        },
        profitableText: (n, k) =>
          `You re-entered within ${REENTRY_MIN} minutes of a loss ${plural(k, 'time')}. Those trades made ${formatSignedInr(n)}, so it isn't hurting you right now.`,
      },
    ];
  },
  notFound: () => `You never re-entered the same instrument within ${REENTRY_MIN} minutes of a loss.`,
};

const overtrading: Detector = {
  id: 'overtrading',
  name: 'Number of trades a day',
  unavailable: (ctx) => (ctx.timed ? null : NEEDS_TIME),
  run(ctx) {
    const counts = [...ctx.days.values()].map((d) => d.length);
    const cap = Math.max(3, Math.round(median(counts)));
    const extra = [...ctx.days.values()].flatMap((d) => d.slice(cap));
    if (!extra.length) return [];
    const busyDays = [...ctx.days.values()].filter((d) => d.length > cap).length;
    return [
      {
        key: 'overtrading',
        id: 'overtrading',
        label: `trades beyond your ${cap}th of the day`,
        type: 'set',
        multi: false,
        tradeIds: extra.map((t) => t.id),
        deltas: setDeltas(extra),
        eligible: true,
        strength: strengthOf(extra.length),
        text: ({ cost, trades }) => {
          const firsts = [...ctx.days.values()].flatMap((d) => d.slice(0, cap));
          return {
            title: 'Trading past your usual number of trades a day',
            summary: `Trades after your first ${cap} of the day cost you ${formatInr(cost)}.`,
            evidence: [
              `On ${plural(busyDays, 'day')} you took more than ${cap} trades (your typical day is ${cap} or fewer)`,
              `Trades beyond the first ${cap}: ${formatSignedInr(net(trades))} over ${plural(trades.length, 'trade')}`,
              `Your first ${cap} trades each day: ${formatSignedInr(net(firsts))}`,
            ],
            rule: `Cap yourself at ${cap} trades a day.`,
          };
        },
        profitableText: (n, k) => `Your extra trades on busy days (${plural(k, 'trade')}) made ${formatSignedInr(n)}.`,
      },
    ];
  },
  notFound: () => 'You kept to a steady number of trades each day.',
};

export const WINDOWS = [
  { key: 'opening', label: 'opening half hour', range: '9:15–9:45 am', from: 0, to: 585 },
  { key: 'morning', label: 'late morning', range: '9:45–11:30 am', from: 585, to: 690 },
  { key: 'midday', label: 'midday', range: '11:30 am–1:30 pm', from: 690, to: 810 },
  { key: 'afternoon', label: 'afternoon', range: '1:30–2:45 pm', from: 810, to: 885 },
  { key: 'closing', label: 'last 45 minutes', range: '2:45–3:30 pm', from: 885, to: 24 * 60 },
] as const;

const timeWindow: Detector = {
  id: 'time-window',
  name: 'Time of day',
  unavailable: (ctx) => (ctx.timed ? null : NEEDS_TIME),
  run(ctx) {
    return WINDOWS.map((w) => {
      const ts = ctx.trades.filter((t) => {
        const m = minuteOfDay(t.entryTime!);
        return m >= w.from && m < w.to;
      });
      return {
        key: `time-window:${w.key}`,
        id: 'time-window' as const,
        label: `${w.label} trades`,
        type: 'set' as const,
        multi: true,
        tradeIds: ts.map((t) => t.id),
        deltas: setDeltas(ts),
        eligible: ts.length >= 5,
        strength: strengthOf(ts.length),
        text: ({ cost, trades }: { cost: number; trades: Trade[] }) => {
          const rest = ctx.trades.filter((t) => !ts.includes(t));
          return {
            title: `Your trades in the ${w.label} lose money`,
            summary: `Trades you opened between ${w.range} cost you ${formatInr(cost)}.`,
            evidence: [
              `${plural(trades.length, 'trade')} opened ${w.range}: ${wins(trades)} won, net ${formatSignedInr(net(trades))}`,
              `Trades at all other times: ${formatSignedInr(net(rest))} over ${plural(rest.length, 'trade')}`,
            ],
            rule: `Don't open new trades between ${w.range} for a month, and see what changes.`,
          };
        },
        profitableText: (n: number, k: number) => `${w.range}: ${formatSignedInr(n)} over ${plural(k, 'trade')}.`,
      };
    }).filter((c) => c.tradeIds.length > 0);
  },
  notFound: () => 'No time of day stood out.',
};

const expiryDay: Detector = {
  id: 'expiry-day',
  name: 'Option trades on expiry day',
  unavailable: (ctx) =>
    ctx.trades.some((t) => t.kind === 'OPTION' && t.expiry)
      ? ctx.trades.some((t) => t.entryTime)
        ? null
        : 'Needs trade dates.'
      : null,
  run(ctx) {
    const ts = ctx.trades.filter((t) => t.kind === 'OPTION' && t.expiry && t.entryTime && dateOf(t.entryTime) === t.expiry);
    if (!ts.length) return [];
    const days = new Set(ts.map((t) => t.expiry)).size;
    return [
      {
        key: 'expiry-day',
        id: 'expiry-day',
        label: 'expiry-day option trades',
        type: 'set',
        multi: false,
        tradeIds: ts.map((t) => t.id),
        deltas: setDeltas(ts),
        eligible: true,
        strength: strengthOf(ts.length),
        text: ({ cost, trades }) => {
          const otherOptions = ctx.trades.filter((t) => t.kind === 'OPTION' && !ts.includes(t));
          return {
            title: 'Trading options on the day they expire',
            summary: `Option trades you opened on the contract's own expiry day cost you ${formatInr(cost)}.`,
            evidence: [
              `${plural(trades.length, 'trade')} across ${plural(days, 'expiry day')}: ${wins(trades)} won, net ${formatSignedInr(net(trades))}`,
              otherOptions.length
                ? `Your other option trades: ${formatSignedInr(net(otherOptions))} over ${plural(otherOptions.length, 'trade')}`
                : 'All of your option trades were on expiry day',
              'On expiry day an option loses its remaining time value within hours, so small moves against you hit hard',
            ],
            rule: "On expiry day, don't open new trades in the contract that is expiring.",
          };
        },
        profitableText: (n, k) => `You traded options on expiry day ${plural(k, 'time')}; those trades made ${formatSignedInr(n)}.`,
      },
    ];
  },
  notFound: (ctx) =>
    ctx.trades.some((t) => t.kind === 'OPTION')
      ? 'None of your option trades were opened on their expiry day.'
      : 'No option trades in this file.',
};

const holdingLosers: Detector = {
  id: 'holding-losers',
  name: 'How long you hold losers vs winners',
  unavailable: (ctx) => (ctx.timed ? null : NEEDS_TIME),
  run(ctx) {
    const timed = ctx.trades.filter((t) => t.holdMinutes !== null);
    const winners = timed.filter((t) => t.netPnl > 0);
    const losers = timed.filter((t) => t.netPnl < 0);
    if (winners.length < 5 || losers.length < 5) return [];
    const medW = Math.max(median(winners.map((t) => t.holdMinutes!)), 1);
    const medL = median(losers.map((t) => t.holdMinutes!));
    const limit = 2 * medW;
    const long = losers.filter((t) => t.holdMinutes! > limit);
    const quick = losers.filter((t) => t.holdMinutes! <= limit);
    if (!long.length) return [];
    const baseline = quick.length >= 3 ? mean(quick.map((t) => t.netPnl)) : 0.5 * mean(long.map((t) => t.netPnl));
    const deltas = Object.fromEntries(long.map((t) => [t.id, Math.max(0, baseline - t.netPnl)]));
    const ratio = medL / medW;
    return [
      {
        key: 'holding-losers',
        id: 'holding-losers',
        label: 'losing trades held too long',
        type: 'excess',
        multi: false,
        tradeIds: long.map((t) => t.id),
        deltas,
        eligible: ratio >= 2 && long.length >= 3,
        strength: long.length >= 10 && ratio >= 3 ? 'strong' : long.length >= 5 ? 'moderate' : 'weak',
        text: ({ cost, trades }) => ({
          title: 'Holding losing trades much longer than winners',
          summary: `Losing trades you held past ${Math.round(limit)} minutes lost ${formatInr(cost)} more than your quicker losses would have.`,
          evidence: [
            `You held winners for ${Math.round(medW)} min and losers for ${Math.round(medL)} min (typical)`,
            `${plural(trades.length, 'losing trade')} held over ${Math.round(limit)} min averaged ${formatInr(mean(trades.map((t) => t.netPnl)))}`,
            quick.length
              ? `Losers you cut sooner averaged ${formatInr(mean(quick.map((t) => t.netPnl)))}`
              : 'You rarely cut a losing trade quickly',
          ],
          rule: `Use a time stop: if a trade isn't working after ${Math.round(limit)} minutes, exit.`,
        }),
        profitableText: () => '',
      },
    ];
  },
  notFound: (ctx) => {
    const timed = ctx.trades.filter((t) => t.holdMinutes !== null);
    const w = timed.filter((t) => t.netPnl > 0).map((t) => t.holdMinutes!);
    const l = timed.filter((t) => t.netPnl < 0).map((t) => t.holdMinutes!);
    if (w.length < 5 || l.length < 5) return 'Not enough winners and losers to compare holding times.';
    return `You hold winners and losers for similar times (${Math.round(median(w))} vs ${Math.round(median(l))} min).`;
  },
};

const sizeAfterLoss: Detector = {
  id: 'size-after-loss',
  name: 'Trade size after a loss',
  unavailable: (ctx) => (!ctx.hasQty ? 'Needs a quantity for every trade.' : ctx.timed ? null : NEEDS_TIME),
  run(ctx) {
    const usual = new Map<string, number>();
    for (const u of new Set(ctx.trades.map((t) => t.underlying))) {
      usual.set(u, median(ctx.trades.filter((t) => t.underlying === u).map((t) => t.qty)));
    }
    const hits: Trade[] = [];
    for (const day of ctx.days.values()) {
      for (const t of day) {
        const last = closedBefore(t, day)[0];
        const base = usual.get(t.underlying)!;
        if (last && last.netPnl < 0 && base > 0 && t.qty >= 1.5 * base) hits.push(t);
      }
    }
    if (!hits.length) return [];
    const deltas = Object.fromEntries(
      hits.map((t) => [t.id, -t.netPnl * (1 - usual.get(t.underlying)! / t.qty)]),
    );
    return [
      {
        key: 'size-after-loss',
        id: 'size-after-loss',
        label: 'oversized trades after a loss',
        type: 'excess',
        multi: false,
        tradeIds: hits.map((t) => t.id),
        deltas,
        eligible: hits.length >= 3,
        strength: strengthOf(hits.length),
        text: ({ cost, trades }) => ({
          title: 'Trading bigger right after a loss',
          summary: `Sizing up straight after a loss cost you ${formatInr(cost)} more than your normal size would have.`,
          evidence: [
            `${plural(trades.length, 'time')} your next trade after a loss was at least 1.5× your usual size`,
            `Those trades: ${wins(trades)} won, net ${formatSignedInr(net(trades))}`,
            `Typical size multiple: ${(median(trades.map((t) => t.qty / usual.get(t.underlying)!))).toFixed(1)}×`,
          ],
          rule: 'After a loss, your next trade uses your normal size or smaller.',
        }),
        profitableText: (n, k) =>
          `You sized up after a loss ${plural(k, 'time')}; the extra size made ${formatSignedInr(n)}.`,
      },
    ];
  },
  notFound: () => 'You kept your usual size after losses.',
};

const feeChurn: Detector = {
  id: 'fee-churn',
  name: 'Charges on small trades',
  unavailable: (ctx) => (ctx.feesKnown ? null : 'Needs charges (or buy/sell prices so they can be estimated).'),
  run(ctx) {
    const ts = ctx.trades.filter((t) => t.grossPnl !== null && t.fees > 0 && t.fees >= 0.3 * Math.abs(t.grossPnl));
    if (!ts.length) return [];
    const typicalFee = median(ctx.trades.map((t) => t.fees));
    return [
      {
        key: 'fee-churn',
        id: 'fee-churn',
        label: 'trades too small to beat charges',
        type: 'excess',
        multi: false,
        tradeIds: ts.map((t) => t.id),
        deltas: Object.fromEntries(ts.map((t) => [t.id, t.fees])),
        eligible: ts.length >= 8,
        strength: strengthOf(ts.length),
        text: ({ cost, trades }) => ({
          title: 'Small trades where charges ate the move',
          summary: `You paid ${formatInr(cost)} in charges on trades whose price move barely covered them.`,
          evidence: [
            `${plural(trades.length, 'trade')} where charges were 30% or more of the price move`,
            `Average move on those trades ${formatInr(mean(trades.map((t) => Math.abs(t.grossPnl!))))} vs ${formatInr(mean(trades.map((t) => t.fees)))} in charges`,
          ],
          rule: `Only take a trade if your target is at least 5× its charges (about ${formatInr(5 * typicalFee)} for a typical trade).`,
        }),
        profitableText: () => '',
      },
    ];
  },
  notFound: () => 'Your trades were large enough that charges were a small share of each move.',
};

export const DETECTORS: Detector[] = [
  instrumentBleed,
  lossStreak,
  quickReentry,
  overtrading,
  timeWindow,
  expiryDay,
  holdingLosers,
  sizeAfterLoss,
  feeChurn,
];

export function buildCtx(trades: Trade[], opts: { timed: boolean; hasQty: boolean; feesKnown: boolean }): Ctx {
  const days = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!t.entryTime) continue;
    const d = dateOf(t.entryTime);
    days.set(d, [...(days.get(d) ?? []), t]);
  }
  if (opts.timed) {
    for (const d of days.values()) d.sort((a, b) => toMinutes(a.entryTime!) - toMinutes(b.entryTime!));
  }
  return {
    trades,
    byId: new Map(trades.map((t) => [t.id, t])),
    timed: opts.timed && trades.every((t) => hasClock(t.entryTime) && hasClock(t.exitTime)),
    hasQty: opts.hasQty,
    feesKnown: opts.feesKnown,
    totalNet: net(trades),
    days,
  };
}
