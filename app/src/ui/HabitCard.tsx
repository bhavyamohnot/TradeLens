import { formatDateTime, formatInr, formatSignedInr } from '../engine';
import type { Commitment, Habit, Review } from '../engine';
import { alsoExplains, confidenceHelp, formatHold, plural } from './util';
import { Disclosure, InfoTip } from './parts';

interface Props {
  habit: Habit;
  review: Review;
  commitment: Commitment | null;
  onCommit: (h: Habit) => void;
  onUncommit: () => void;
}

export function TradeStrip({ habit, review }: { habit: Habit; review: Review }) {
  const set = new Set(habit.tradeIds);
  const hit = review.trades.filter((t) => set.has(t.id)).length;
  return (
    <div className="strip-wrap">
      <div className="strip" role="img" aria-label={`All ${review.trades.length} trades in order. ${hit} belong to this habit.`}>
        {review.trades.map((t) => {
          const on = set.has(t.id);
          const cls = on ? (t.netPnl < 0 ? 'dot on loss' : 'dot on gain') : 'dot';
          return <span key={t.id} className={cls} title={`${formatDateTime(t.entryTime)} · ${t.symbol} · ${formatSignedInr(t.netPnl)}`} />;
        })}
      </div>
      <p className="strip-key">
        Each dot is one of your {review.trades.length} trades, oldest first. <span className="k loss" /> Habit trades that lost <span className="k gain" /> Habit trades that won <span className="k" /> Other trades
      </p>
    </div>
  );
}

export function TradeTable({ ids, review }: { ids: string[]; review: Review }) {
  const set = new Set(ids);
  const rows = review.trades.filter((t) => set.has(t.id));
  return (
    <div className="table-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Entry</th>
            <th>Symbol</th>
            <th className="num">Qty</th>
            <th className="num">Held</th>
            <th className="num">Net P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{formatDateTime(t.entryTime)}</td>
              <td className="sym">{t.symbol}</td>
              <td className="num">{t.qty.toLocaleString('en-IN')}</td>
              <td className="num">{formatHold(t.holdMinutes)}</td>
              <td className={`num ${t.netPnl < 0 ? 'neg' : 'pos'}`}>{formatSignedInr(t.netPnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HabitCard({ habit, review, commitment, onCommit, onUncommit }: Props) {
  const committed = commitment?.key === habit.key;
  const otherCommitted = !!commitment && !committed;
  return (
    <article className="card habit" aria-labelledby={`h-${habit.rank}`}>
      <div className="habit-top">
        <span className="rank" aria-hidden="true">
          {habit.rank}
        </span>
        <div className="habit-head">
          <h3 id={`h-${habit.rank}`}>
            <span className="sr-only">Habit {habit.rank}: </span>
            {habit.title}
          </h3>
          <p className="habit-sum">{habit.summary}</p>
        </div>
        <div className="cost">
          <span className="cost-n">{formatInr(habit.cost)}</span>
          <span className="cost-l">cost you</span>
        </div>
      </div>

      <div className="evidence">
        <ul>
          {habit.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <span className={`badge conf-${habit.confidence}`}>
          {habit.confidence === 'high' ? 'High' : habit.confidence === 'medium' ? 'Medium' : 'Low'} confidence
          <InfoTip text={confidenceHelp()} />
        </span>
      </div>

      <TradeStrip habit={habit} review={review} />

      <div className="rule">
        <div className="rule-label">Rule to try next month</div>
        <p>{habit.rule}</p>
        <div className="rule-actions no-print">
          {committed ? (
            <>
              <span className="committed">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                You committed to this rule. Upload next month's file and we will check how it went.
              </span>
              <button type="button" className="link-btn" onClick={onUncommit}>
                Undo
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onCommit(habit)}>
              {otherCommitted ? 'Commit to this rule instead' : 'Commit to this rule'}
            </button>
          )}
        </div>
        {otherCommitted && !committed && <p className="rule-note no-print">You can commit to one rule at a time. Currently: {commitment?.title}.</p>}
      </div>

      <Disclosure label={`See the ${plural(habit.tradeIds.length, 'trade')}`}>
        <TradeTable ids={habit.tradeIds} review={review} />
      </Disclosure>

      {habit.overlapsWith.length > 0 && <p className="also">Also explains: {alsoExplains(habit.overlapsWith, review.cleared)}</p>}
    </article>
  );
}
