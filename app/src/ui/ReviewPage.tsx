import { useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { checkCommitment, formatDate, formatDateTime, formatInr, formatSignedInr } from '../engine';
import type { Commitment, CommitmentCheck, Habit, ParseResult, Review } from '../engine';
import EquityChart from './EquityChart';
import HabitCard from './HabitCard';
import { buildMarkdown } from './exportMarkdown';
import { Disclosure, PrintContext, Wordmark } from './parts';
import { baseName, downloadText, formatHold, loadCommitment, plural, saveCommitment } from './util';

interface Props {
  fileName: string;
  review: Review;
  parsed: ParseResult | null;
  onCheckColumns?: () => void;
  onNew: () => void;
}

function useCommitment(review: Review) {
  const [commitment, setCommitment] = useState<Commitment | null>(() => loadCommitment());
  const commit = (h: Habit) => {
    const c: Commitment = {
      key: h.key,
      id: h.id,
      title: h.title,
      rule: h.rule,
      baselineCost: h.cost,
      baselinePeriod: review.summary.periodLabel,
      committedAt: new Date().toISOString(),
    };
    saveCommitment(c);
    setCommitment(c);
  };
  const clear = () => {
    saveCommitment(null);
    setCommitment(null);
  };
  return { commitment, commit, clear };
}

function usePrinting() {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  return printing;
}

function Figure({ label, value, tone, sub }: { label: string; value: string; tone?: 'neg' | 'pos'; sub?: string }) {
  return (
    <div className="fig">
      <div className="fig-l">{label}</div>
      <div className={`fig-v ${tone ?? ''}`}>{value}</div>
      {sub && <div className="fig-s">{sub}</div>}
    </div>
  );
}

export default function ReviewPage({ fileName, review, parsed, onCheckColumns, onNew }: Props) {
  const s = review.summary;
  const { commitment, commit, clear } = useCommitment(review);
  const printing = usePrinting();
  const [filter, setFilter] = useState<'all' | string>('all');

  const check: CommitmentCheck | null = useMemo(() => {
    if (!commitment || commitment.baselinePeriod === s.periodLabel) return null;
    try {
      return checkCommitment(commitment, review);
    } catch {
      return null;
    }
  }, [commitment, review, s.periodLabel]);

  const lastEq = review.equity[review.equity.length - 1];
  const fixed1 = review.habits.length > 0 && lastEq?.withoutHabits.length ? lastEq.withoutHabits[0] : null;

  const habitsByTrade = useMemo(() => {
    const m = new Map<string, number[]>();
    review.habits.forEach((h) => h.tradeIds.forEach((id) => m.set(id, [...(m.get(id) ?? []), h.rank])));
    return m;
  }, [review.habits]);
  const filtered = useMemo(() => {
    if (filter === 'all') return review.trades;
    const h = review.habits.find((x) => x.key === filter);
    const set = new Set(h?.tradeIds ?? []);
    return review.trades.filter((t) => set.has(t.id));
  }, [filter, review]);

  const print = () => window.print();

  const notes = [...review.notes];
  // Skipped rows and open positions are already explained in review.notes by the engine.
  const extra: string[] = [];
  const feesEstimated = parsed && (parsed.coverage.fees === 'estimated' || parsed.coverage.fees === 'mixed');
  const hasFeeNote = notes.some((n) => /charge|fee/i.test(n.text));
  if (feesEstimated && !hasFeeNote) extra.push('Charges were estimated because the file did not report them. Net P&L may be off by a small amount.');

  const profitable = review.cleared.filter((c) => c.reason === 'profitable');
  const otherCleared = review.cleared.filter((c) => c.reason !== 'profitable');

  const glance: [string, string][] = [
    ['Trades', `${s.trades} (${s.wins} won, ${s.losses} lost)`],
    ['Trading days', String(s.tradingDays)],
    ['Win rate', `${s.winRate.toFixed(0)}%`],
    ['Average win', formatSignedInr(s.avgWin)],
    ['Average loss', formatSignedInr(s.avgLoss)],
    ['Max drawdown', formatInr(s.maxDrawdown)],
    ['Best day', s.bestDay ? `${formatSignedInr(s.bestDay.netPnl)} · ${formatDate(s.bestDay.date)}` : '—'],
    ['Worst day', s.worstDay ? `${formatSignedInr(s.worstDay.netPnl)} · ${formatDate(s.worstDay.date)}` : '—'],
    ['Longest losing streak', plural(s.longestLosingStreak, 'trade')],
    ['Gross P&L', s.grossPnl === null ? 'Not in file' : formatSignedInr(s.grossPnl)],
  ];

  return (
    <PrintContext.Provider value={printing}>
      <div className="page review">
        <div className="topbar no-print">
          <div className="wrap topbar-inner">
            <Wordmark />
          </div>
        </div>
        <main className="wrap narrow">
          <header className="rv-head">
            <div>
              <p className="eyebrow">Your review</p>
              <h1 className="page-title">{s.periodLabel}</h1>
              <p className="meta">
                {fileName} · {plural(s.trades, 'trade')}
                {s.from && s.to ? ` · ${formatDate(s.from)} to ${formatDate(s.to)}` : ''}
              </p>
            </div>
            <div className="actions no-print">
              {onCheckColumns && (
                <button type="button" className="btn btn-quiet" onClick={onCheckColumns}>
                  Check columns
                </button>
              )}
              <button type="button" className="btn btn-quiet" onClick={() => downloadText(`tradelens-${baseName(fileName)}.md`, buildMarkdown(review, fileName, parsed ?? undefined))}>
                Download review (.md)
              </button>
              <button type="button" className="btn btn-quiet" onClick={print}>
                Print / save PDF
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={onNew}>
                New review
              </button>
            </div>
          </header>

          {check && (
            <div className={`banner banner-${check.status}`} role="status">
              <div className="banner-l">Last time you committed to: {check.commitment.title}</div>
              <p>{check.text}</p>
            </div>
          )}

          <section className="verdict" aria-label="Verdict">
            <p className="verdict-text">{review.verdict}</p>
            <div className="figs">
              <Figure label="Net P&L" value={formatSignedInr(s.netPnl)} tone={s.netPnl < 0 ? 'neg' : 'pos'} />
              <Figure label="Charges" value={formatInr(s.fees)} sub="brokerage and taxes" />
              {fixed1 !== null && <Figure label="If you'd fixed habit #1" value={formatSignedInr(fixed1)} tone={fixed1 < 0 ? 'neg' : 'pos'} sub={`${formatSignedInr(fixed1 - s.netPnl)} vs what happened`} />}
            </div>
          </section>

          <section aria-labelledby="habits-h">
            <h2 id="habits-h" className="sec-title">
              {review.habits.length > 0 ? `The ${review.habits.length === 1 ? 'habit' : `${review.habits.length} habits`} costing you money` : 'Habits'}
            </h2>
            {review.habits.length === 0 ? (
              <div className="card calm">
                <h3>No costly habit stood out this month</h3>
                <p>We checked the usual suspects and none of them clearly cost you money. The list further down shows what we looked at.</p>
              </div>
            ) : (
              <div className="stack">
                {review.habits.map((h) => (
                  <HabitCard key={h.key} habit={h} review={review} commitment={commitment} onCommit={commit} onUncommit={clear} />
                ))}
              </div>
            )}
          </section>

          {review.equity.length > 1 && (
            <section aria-labelledby="chart-h">
              <h2 id="chart-h" className="sec-title">
                Your month, with and without these habits
              </h2>
              <div className="card chart-card">
                <EquityChart review={review} />
                {review.habits.length > 0 && <p className="chart-note">Dashed lines show what your running total would have been if the habit trades had broken even.</p>}
              </div>
            </section>
          )}

          <section aria-labelledby="clear-h">
            <h2 id="clear-h" className="sec-title">
              Checked, not costing you money
            </h2>
            {review.cleared.length === 0 ? (
              <p className="muted">Nothing else to report.</p>
            ) : (
              <>
                {profitable.length > 0 && (
                  <ul className="clist good">
                    {profitable.map((c) => (
                      <li key={c.key}>
                        <span className="tick" aria-hidden="true">
                          ✓
                        </span>
                        <div>
                          <strong>{c.title}</strong> <span className="tag gain">Made you money</span>
                          <p>{c.detail}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {otherCleared.length > 0 && (
                  <ul className="clist">
                    {otherCleared.map((c) => (
                      <li key={c.key}>
                        <span className="tick" aria-hidden="true">
                          ✓
                        </span>
                        <div>
                          <strong>{c.title}</strong>
                          <p>{c.detail}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {review.unavailable.length > 0 && (
            <section aria-labelledby="unav-h">
              <h2 id="unav-h" className="sec-title">
                Couldn't check
              </h2>
              <ul className="clist">
                {review.unavailable.map((u) => (
                  <li key={u.id}>
                    <span className="tick dash" aria-hidden="true">
                      –
                    </span>
                    <div>
                      <strong>{u.title}</strong>
                      <p>{u.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="glance-h" className="glance">
            <h2 id="glance-h" className="sec-title small">
              Month at a glance
            </h2>
            <dl className="glance-grid">
              {glance.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>

          {(notes.length > 0 || extra.length > 0) && (
            <section aria-labelledby="notes-h">
              <h2 id="notes-h" className="sec-title small">
                Data notes
              </h2>
              <ul className="notes">
                {notes.map((n, i) => (
                  <li key={i} className={n.level}>
                    <span className="lvl">{n.level === 'warn' ? 'Heads up' : 'Note'}</span> {n.text}
                  </li>
                ))}
                {extra.map((t, i) => (
                  <li key={`x${i}`} className="info">
                    <span className="lvl">Note</span> {t}
                  </li>
                ))}
              </ul>
              {parsed && parsed.rejected.length > 0 && (
                <Disclosure label={`See the ${plural(parsed.rejected.length, 'skipped row')}`} className="no-print">
                  <ul className="notes">
                    {parsed.rejected.slice(0, 50).map((r, i) => (
                      <li key={i} className="info">
                        Row {r.row}: {r.reason}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </section>
          )}

          <section aria-labelledby="all-h">
            <Disclosure label={<span id="all-h">All {plural(review.trades.length, 'trade')}</span>}>
              {review.habits.length > 0 && (
                <div className="chips no-print" role="group" aria-label="Filter trades">
                  <button type="button" className={`chip${filter === 'all' ? ' on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                    All trades
                  </button>
                  {review.habits.map((h) => (
                    <button key={h.key} type="button" className={`chip${filter === h.key ? ' on' : ''}`} aria-pressed={filter === h.key} onClick={() => setFilter(h.key)}>
                      Habit {h.rank}
                    </button>
                  ))}
                </div>
              )}
              <div className="table-scroll tall">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Entry</th>
                      <th>Symbol</th>
                      <th className="num">Qty</th>
                      <th className="num">Held</th>
                      <th className="num">Net P&amp;L</th>
                      <th>Habit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => (
                      <tr key={t.id}>
                        <td>{formatDateTime(t.entryTime)}</td>
                        <td className="sym">{t.symbol}</td>
                        <td className="num">{t.qty.toLocaleString('en-IN')}</td>
                        <td className="num">{formatHold(t.holdMinutes)}</td>
                        <td className={`num ${t.netPnl < 0 ? 'neg' : 'pos'}`}>{formatSignedInr(t.netPnl)}</td>
                        <td>{habitsByTrade.get(t.id)?.map((r) => `#${r}`).join(' ') ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Disclosure>
          </section>

          <footer className="foot-note">
            Analysed in your browser. Your file was not uploaded. This is a review of past trades, not investment advice.
          </footer>
        </main>
      </div>
    </PrintContext.Provider>
  );
}
