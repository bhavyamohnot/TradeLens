import type { Cleared, Confidence, EquityPoint, Habit, Note, ParseResult, Review, Summary, Trade, Unavailable } from './types';
import { DETECTORS, buildCtx, type Candidate, type Ctx } from './detectors';
import { formatInr, formatSignedInr, formatDate } from './format';
import { dateOf, toMinutes } from './time';
import { round2, sum, welchT } from './stats';

const MAX_HABITS = 3;
const MIN_TRADES = 3;
const MATERIALITY = 0.05; // a habit must explain >= 5% of the month's total losses
const T_SINGLE = -2;
const T_MULTI = -3;
const MAX_SHARE = 0.8; // a "habit" covering >80% of trades is just the whole month

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function chronological(trades: Trade[]): Trade[] {
  const key = (t: Trade) => t.exitTime ?? t.entryTime;
  if (!trades.every(key)) return trades;
  return trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const d = toMinutes(key(a.t)!) - toMinutes(key(b.t)!);
      return d || a.i - b.i;
    })
    .map((x) => x.t);
}

function periodLabel(from: string | null, to: string | null): string {
  if (!from || !to) return 'This period';
  if (from.slice(0, 7) === to.slice(0, 7)) return `${MONTH_NAMES[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  return `${formatDate(from)} – ${formatDate(to)}`;
}

function summarise(trades: Trade[]): Summary {
  const dates = trades.map((t) => t.entryTime ?? t.exitTime).filter((d): d is string => !!d).map(dateOf).sort();
  const from = dates[0] ?? null;
  const to = dates[dates.length - 1] ?? null;
  const w = trades.filter((t) => t.netPnl > 0);
  const l = trades.filter((t) => t.netPnl < 0);
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const d = t.entryTime ?? t.exitTime;
    if (d) byDay.set(dateOf(d), (byDay.get(dateOf(d)) ?? 0) + t.netPnl);
  }
  const dayList = [...byDay].map(([date, n]) => ({ date, netPnl: round2(n) }));
  let peak = 0;
  let eq = 0;
  let dd = 0;
  let run = 0;
  let longest = 0;
  for (const t of chronological(trades)) {
    eq += t.netPnl;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    run = t.netPnl < 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return {
    from,
    to,
    periodLabel: periodLabel(from, to),
    trades: trades.length,
    tradingDays: byDay.size,
    wins: w.length,
    losses: l.length,
    winRate: trades.length ? round2((w.length / trades.length) * 100) : 0,
    grossPnl: trades.every((t) => t.grossPnl !== null) ? round2(sum(trades.map((t) => t.grossPnl!))) : null,
    fees: round2(sum(trades.map((t) => t.fees))),
    netPnl: round2(sum(trades.map((t) => t.netPnl))),
    avgWin: w.length ? round2(sum(w.map((t) => t.netPnl)) / w.length) : 0,
    avgLoss: l.length ? round2(sum(l.map((t) => t.netPnl)) / l.length) : 0,
    maxDrawdown: round2(dd),
    bestDay: dayList.length ? dayList.reduce((a, b) => (b.netPnl > a.netPnl ? b : a)) : null,
    worstDay: dayList.length ? dayList.reduce((a, b) => (b.netPnl < a.netPnl ? b : a)) : null,
    longestLosingStreak: longest,
  };
}

interface Scored {
  c: Candidate;
  standalone: number; // ₹ saved if fixed, all trades
  significant: boolean;
  t: number | null;
}

function score(c: Candidate, ctx: Ctx): Scored {
  const standalone = sum(Object.values(c.deltas));
  if (c.type === 'excess') return { c, standalone, significant: c.eligible, t: null };
  const inSet = new Set(c.tradeIds);
  const a = ctx.trades.filter((t) => inSet.has(t.id)).map((t) => t.netPnl);
  const b = ctx.trades.filter((t) => !inSet.has(t.id)).map((t) => t.netPnl);
  const t = welchT(a, b);
  const significant =
    c.eligible && a.length / ctx.trades.length <= MAX_SHARE && t !== null && t <= (c.multi ? T_MULTI : T_SINGLE);
  return { c, standalone, significant, t };
}

const marginal = (c: Candidate, taken: Set<string>) => {
  const base = c.refine ? c.refine(taken) : c;
  const ids = base.tradeIds.filter((id) => !taken.has(id));
  return { ids, cost: sum(ids.map((id) => base.deltas[id] ?? 0)), deltas: base.deltas };
};

function confidenceOf(s: Scored, n: number): Confidence {
  if (s.c.strength === 'weak' || n < 5) return 'low';
  if (s.c.type === 'set') {
    if (n >= 10 && s.t !== null && s.t <= -3) return 'high';
    return 'medium';
  }
  return s.c.strength === 'strong' ? 'high' : 'medium';
}

export function analyze(parsed: ParseResult): Review {
  const trades = chronological(parsed.trades);
  const ctx = buildCtx(trades, {
    timed: parsed.coverage.timestamps,
    hasQty: parsed.coverage.quantity,
    feesKnown: ['reported', 'estimated', 'mixed'].includes(parsed.coverage.fees),
  });
  const summary = summarise(trades);
  const totalLoss = sum(trades.filter((t) => t.netPnl < 0).map((t) => -t.netPnl));
  const threshold = Math.max(MATERIALITY * totalLoss, 1);

  const unavailable: Unavailable[] = [];
  const ran: { detector: (typeof DETECTORS)[number]; scored: Scored[] }[] = [];
  for (const d of DETECTORS) {
    const reason = d.unavailable(ctx);
    if (reason) unavailable.push({ id: d.id, title: d.name, reason });
    else ran.push({ detector: d, scored: d.run(ctx).map((c) => score(c, ctx)) });
  }

  // Greedy selection by marginal cost: the biggest habit claims its trades,
  // the next one only gets credit for trades not already explained. A
  // trade-set habit must still stand out on the trades it has left.
  const pool = ran.flatMap((r) => r.scored).filter((s) => s.significant && s.standalone > 0);
  const taken = new Set<string>();
  const chosen: { s: Scored; cost: number; ids: string[]; deltas: Record<string, number>; before: Set<string> }[] = [];
  const stillSignificant = (s: Scored, ids: string[]) => {
    if (s.c.type === 'excess') return true;
    const inSet = new Set(ids);
    const t = welchT(
      ids.map((id) => ctx.byId.get(id)!.netPnl),
      trades.filter((x) => !inSet.has(x.id)).map((x) => x.netPnl),
    );
    return t !== null && t <= (s.c.multi ? T_MULTI : T_SINGLE);
  };
  while (chosen.length < MAX_HABITS) {
    const options = pool
      .filter((s) => !chosen.some((x) => x.s === s))
      .map((s) => ({ s, ...marginal(s.c, taken) }))
      .filter((o) => o.ids.length >= MIN_TRADES && o.cost >= threshold && stillSignificant(o.s, o.ids));
    if (!options.length) break;
    let best = options.reduce((a, b) => (b.cost > a.cost ? b : a));
    // Prefer a narrower habit nested inside the winner when it explains most of
    // its cost: "options on expiry day" is more fixable than "NIFTY loses".
    const inBest = new Set(best.ids);
    const narrower = options
      .filter((o) => o !== best && o.ids.length < best.ids.length)
      .filter((o) => o.ids.filter((id) => inBest.has(id)).length >= 0.9 * o.ids.length && o.cost >= 0.6 * best.cost)
      .sort((a, b) => b.cost - a.cost)[0];
    if (narrower) best = narrower;
    chosen.push({ ...best, before: new Set(taken) });
    best.ids.forEach((id) => taken.add(id));
  }
  // A re-measured habit can end up costing more than one picked before it.
  // Re-rank by cost and re-measure in that order until the order is stable.
  for (let pass = 0; pass < 3; pass++) {
    if (chosen.every((x, i) => i === 0 || chosen[i - 1].cost >= x.cost)) break;
    chosen.sort((a, b) => b.cost - a.cost);
    const claimed = new Set<string>();
    for (const x of chosen) {
      const m = marginal(x.s.c, claimed);
      Object.assign(x, m, { before: new Set(claimed) });
      m.ids.forEach((id) => claimed.add(id));
    }
  }

  const habits: Habit[] = chosen.map(({ s, cost, ids, deltas, before }, i) => {
    const habitTrades = ids.map((id) => ctx.byId.get(id)!);
    s.c.refine?.(before); // evidence text describes the trades as measured at selection
    const text = s.c.text({ cost, trades: habitTrades, ctx });
    const title = text.title.length > 60 ? `${text.title.slice(0, 57)}…` : text.title;
    return {
      key: s.c.key,
      id: s.c.id,
      rank: i + 1,
      title,
      summary: text.summary,
      cost: round2(cost),
      standaloneCost: round2(s.standalone),
      tradeIds: ids,
      evidence: text.evidence,
      rule: text.rule,
      confidence: confidenceOf(s, ids.length),
      overlapsWith: [],
      adjustments: Object.fromEntries(ids.map((id) => [id, round2(deltas[id] ?? 0)])),
    };
  });

  // Everything we checked that did not make the list, one line per detector.
  const cleared: Cleared[] = [];
  const chosenKeys = new Set(habits.map((h) => h.key));
  for (const { detector, scored } of ran) {
    const rest = scored.filter((s) => !chosenKeys.has(s.c.key));
    const picked = habits.filter((h) => h.id === detector.id);
    if (!scored.length) {
      if (!picked.length) cleared.push({ key: detector.id, id: detector.id, title: detector.name, detail: detector.notFound(ctx), reason: 'not-found' });
      continue;
    }
    // Overlap: looked costly alone, but a higher-ranked habit already explains it.
    const overlapped = rest.filter((s) => s.significant && s.standalone >= threshold && marginal(s.c, taken).cost < threshold);
    for (const s of overlapped) {
      const owner = habits
        .map((h) => ({ h, shared: s.c.tradeIds.filter((id) => h.tradeIds.includes(id)).length }))
        .sort((a, b) => b.shared - a.shared)[0];
      if (!owner || owner.shared === 0) continue;
      owner.h.overlapsWith.push(s.c.key);
      const left = marginal(s.c, new Set(owner.h.tradeIds));
      const leftNet = -left.cost;
      cleared.push({
        key: s.c.key,
        id: s.c.id,
        title: s.c.label.charAt(0).toUpperCase() + s.c.label.slice(1),
        detail: `On its own this looks costly (${formatSignedInr(-s.standalone)}), but it is mostly the same trades as habit #${owner.h.rank}. ${
          left.ids.length ? `The other ${left.ids.length} trades made ${formatSignedInr(leftNet)}.` : ''
        }`.trim(),
        reason: 'overlap',
      });
    }
    if (picked.length || overlapped.length) continue;

    // Report the worst remaining variant once, judged on trades not already explained.
    const judged = rest
      .map((s) => ({ s, m: marginal(s.c, taken) }))
      .filter((x) => x.m.ids.length > 0)
      .sort((a, b) => b.m.cost - a.m.cost);
    const worst = judged[0];
    if (!worst) continue;
    const n = worst.m.ids.length;
    const lost = worst.m.cost;
    const setNet = -lost;
    if (worst.s.c.type === 'set' && setNet >= 0) {
      const multi = worst.s.c.multi;
      cleared.push({
        key: multi ? detector.id : worst.s.c.key,
        id: detector.id,
        title: detector.name,
        detail: multi
          ? `None lost money${taken.size ? ' once the habits above are set aside' : ''}. Weakest: ${worst.s.c.profitableText(setNet, n)}`
          : worst.s.c.profitableText(setNet, n),
        reason: 'profitable',
      });
    } else if (worst.s.c.type === 'excess' && lost <= 0) {
      const text = worst.s.c.profitableText(-lost, n);
      cleared.push({ key: worst.s.c.key, id: detector.id, title: detector.name, detail: text || detector.notFound(ctx), reason: text ? 'profitable' : 'not-found' });
    } else if (!worst.s.significant) {
      cleared.push({
        key: worst.s.c.key,
        id: detector.id,
        title: detector.name,
        detail:
          worst.s.c.type === 'excess'
            ? `${detector.notFound(ctx)} (${n} borderline ${n === 1 ? 'case' : 'cases'}, ${formatInr(lost)} — too few to call a habit.)`
            : `${worst.s.c.label.charAt(0).toUpperCase() + worst.s.c.label.slice(1)} lost ${formatInr(lost)} over ${n} ${n === 1 ? 'trade' : 'trades'}, which is within normal ups and downs for that many trades.`,
        reason: 'not-significant',
      });
    } else {
      cleared.push({
        key: worst.s.c.key,
        id: detector.id,
        title: detector.name,
        detail: `${worst.s.c.label.charAt(0).toUpperCase() + worst.s.c.label.slice(1)} cost ${formatInr(lost)}, under 5% of the month's losses — too small to prioritise.`,
        reason: 'too-small',
      });
    }
  }

  // Equity curve: actual, and with habits 1..i fixed.
  const equity: EquityPoint[] = [];
  let actual = 0;
  const fixed = habits.map(() => 0);
  for (const t of trades) {
    actual += t.netPnl;
    let add = 0;
    habits.forEach((h, i) => {
      add += h.adjustments[t.id] ?? 0;
      fixed[i] += t.netPnl + add;
    });
    equity.push({ tradeId: t.id, time: t.exitTime ?? t.entryTime, actual: round2(actual), withoutHabits: fixed.map(round2) });
  }

  const notes: Note[] = [...parsed.notes];
  if (trades.length < 20) {
    notes.push({ level: 'warn', text: `Only ${trades.length} ${trades.length === 1 ? 'trade' : 'trades'}. Patterns from so few trades can be chance, so treat them as things to watch.` });
  }
  const grossWins = sum(trades.map((t) => Math.max(t.grossPnl ?? 0, 0)));
  if (summary.fees > 0 && grossWins > 0 && summary.fees / grossWins >= 0.2) {
    notes.push({
      level: 'info',
      text: `Charges came to ${formatInr(summary.fees)}, ${Math.round((summary.fees / grossWins) * 100)}% of what your winning trades made before charges.`,
    });
  }

  return {
    summary,
    verdict: verdict(summary, habits),
    habits,
    cleared,
    unavailable,
    equity,
    notes,
    trades,
  };
}

const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

function verdict(s: Summary, habits: Habit[]): string {
  const lead = s.netPnl < 0 ? `You lost ${formatInr(-s.netPnl)} in ${s.periodLabel}.` : `You made ${formatInr(s.netPnl)} in ${s.periodLabel}.`;
  if (!habits.length) {
    return `${lead} No single habit stood out as costing you money${s.netPnl < 0 ? '; the losses were spread across your trades rather than one repeated pattern' : ''}.`;
  }
  const total = sum(habits.map((h) => h.cost));
  const after = s.netPnl + total;
  const count = ['One habit', 'Two habits', 'Three habits'][habits.length - 1];
  const what =
    habits.length === 1
      ? `${count} cost you ${formatInr(total)}: ${lowerFirst(habits[0].title)}.`
      : `${count} cost you ${formatInr(total)}, led by ${lowerFirst(habits[0].title)} (${formatInr(habits[0].cost)}).`;
  const counterfactual =
    s.netPnl < 0 && after > 0
      ? ` Without ${habits.length === 1 ? 'it' : 'them'} you would have been up ${formatInr(after)}.`
      : ` Without ${habits.length === 1 ? 'it' : 'them'} the month would be ${formatSignedInr(after)}.`;
  return `${lead} ${what}${counterfactual}`;
}
