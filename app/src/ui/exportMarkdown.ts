import { formatDate, formatInr, formatSignedInr } from '../engine';
import type { ParseResult, Review } from '../engine';
import { alsoExplains, formatHold, plural } from './util';

export function buildMarkdown(review: Review, fileName: string, parsed?: ParseResult): string {
  const s = review.summary;
  const L: string[] = [];
  const byId = new Map(review.trades.map((t) => [t.id, t]));
  const lastEq = review.equity[review.equity.length - 1];

  L.push(`# TradeLens review: ${s.periodLabel}`, '');
  L.push(`File: ${fileName} · ${plural(s.trades, 'trade')} · ${plural(s.tradingDays, 'trading day')}`, '');
  L.push(`> ${review.verdict}`, '');
  L.push(`- Net P&L: ${formatSignedInr(s.netPnl)}`);
  L.push(`- Charges: ${formatInr(s.fees)}`);
  if (review.habits.length > 0 && lastEq && lastEq.withoutHabits.length > 0) {
    L.push(`- If you had fixed habit #1: ${formatSignedInr(lastEq.withoutHabits[0])}`);
  }
  L.push('');

  L.push('## Habits costing you money', '');
  if (review.habits.length === 0) {
    L.push('No costly habit stood out this month.', '');
  }
  for (const h of review.habits) {
    L.push(`### ${h.rank}. ${h.title}`, '');
    L.push(`**Cost you ${formatInr(h.cost)}** (${h.confidence} confidence)`, '');
    L.push(h.summary, '');
    for (const e of h.evidence) L.push(`- ${e}`);
    L.push('');
    L.push(`**Rule to try next month:** ${h.rule}`, '');
    if (h.overlapsWith.length) L.push(`Also explains: ${alsoExplains(h.overlapsWith, review.cleared)}`, '');
    const rows = h.tradeIds.map((id) => byId.get(id)).filter((t) => !!t);
    if (rows.length) {
      L.push(`${plural(rows.length, 'trade')} behind this habit:`, '');
      L.push('| Entry | Symbol | Qty | Hold | Net P&L |', '| --- | --- | ---: | ---: | ---: |');
      for (const t of rows) {
        if (!t) continue;
        L.push(`| ${t.entryTime ? t.entryTime.replace('T', ' ').slice(0, 16) : '—'} | ${t.symbol} | ${t.qty} | ${formatHold(t.holdMinutes)} | ${formatSignedInr(t.netPnl)} |`);
      }
      L.push('');
    }
  }

  if (review.cleared.length) {
    L.push('## Checked, not costing you money', '');
    for (const c of review.cleared) L.push(`- **${c.title}.** ${c.detail}`);
    L.push('');
  }
  if (review.unavailable.length) {
    L.push("## Couldn't check", '');
    for (const u of review.unavailable) L.push(`- **${u.title}.** ${u.reason}`);
    L.push('');
  }

  L.push('## Month at a glance', '');
  L.push(`- Trades: ${s.trades} (${s.wins} wins, ${s.losses} losses), win rate ${s.winRate.toFixed(0)}%`);
  L.push(`- Trading days: ${s.tradingDays}`);
  L.push(`- Gross P&L: ${s.grossPnl === null ? 'not available' : formatSignedInr(s.grossPnl)}`);
  L.push(`- Charges: ${formatInr(s.fees)}`);
  L.push(`- Net P&L: ${formatSignedInr(s.netPnl)}`);
  L.push(`- Average win: ${formatSignedInr(s.avgWin)}, average loss: ${formatSignedInr(s.avgLoss)}`);
  L.push(`- Max drawdown: ${formatInr(s.maxDrawdown)}`);
  if (s.bestDay) L.push(`- Best day: ${formatDate(s.bestDay.date)} (${formatSignedInr(s.bestDay.netPnl)})`);
  if (s.worstDay) L.push(`- Worst day: ${formatDate(s.worstDay.date)} (${formatSignedInr(s.worstDay.netPnl)})`);
  L.push(`- Longest losing streak: ${plural(s.longestLosingStreak, 'trade')}`, '');

  const notes = [...review.notes.map((n) => `${n.level === 'warn' ? 'Warning: ' : ''}${n.text}`)];
  if (parsed?.rejected.length) notes.push(`${plural(parsed.rejected.length, 'row')} could not be read and were left out.`);
  if (parsed?.openPositions.length) notes.push(`${plural(parsed.openPositions.length, 'position')} still open at the end of the file were left out.`);
  if (notes.length) {
    L.push('## Data notes', '');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }
  L.push('---', '', 'Made with TradeLens. The file was analysed in the browser and never uploaded. This is a review of past trades, not investment advice.', '');
  return L.join('\n');
}
