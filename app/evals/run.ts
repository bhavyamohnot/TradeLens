// `npm run eval`: runs every eval case, prints a table, writes evals/REPORT.md
// and exits 1 if the ship bar fails.
//
// Ship bar:
//   1. every fixed case passes
//   2. every copy / consistency check passes on every review produced
//   3. for every habit type: recall@3 >= 90% and top-1 >= 80% over 20 seeds
//   4. false-positive rate on the clean control <= 10% over 30 seeds

import fs from 'node:fs';
import path from 'node:path';
import type { Review } from '../src/engine';
import {
  fixedCases,
  range,
  reviewChecks,
  runCase,
  sweepClean,
  sweepHabit,
  type CaseOutcome,
  type Check,
  type CleanSweep,
  type SweepRow,
} from './cases';
import { HABIT_KINDS, type HabitKind } from './generators';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPORT = path.join(ROOT, 'evals', Number(process.env.SEED_OFFSET ?? 0) ? `REPORT-heldout-${process.env.SEED_OFFSET}.md` : 'REPORT.md');

const BAR = { recall3: 0.9, top1: 0.8, falsePositive: 0.1 };
// SEED_OFFSET=1000 npm run eval  -> a held-out seed set, to check that tuning on the
// default seeds didn't just overfit them.
const SEED_OFFSET = Number(process.env.SEED_OFFSET ?? 0);
const HABIT_SEEDS = range(1 + SEED_OFFSET, 20);
const CLEAN_SEEDS = range(1 + SEED_OFFSET, 30);
const CURVE_KINDS: HabitKind[] = ['instrument-bleed', 'quick-reentry', 'expiry-day'];
const CURVE_STRENGTHS = [0.25, 0.5, 1.0];

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pctOrDash = (x: number | null) => (x === null ? '-' : pct(x));
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const rpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const mdEscape = (s: string) => s.replace(/\|/g, '\\|');

interface CopyFinding {
  source: string;
  check: Check;
}

function main(): void {
  const t0 = Date.now();
  const outcomes: CaseOutcome[] = fixedCases().map(runCase);

  // --- sweeps ------------------------------------------------------------
  const sweeps = new Map<string, SweepRow>();
  for (const kind of HABIT_KINDS) sweeps.set(`${kind}@1`, sweepHabit(kind, HABIT_SEEDS, 1));
  const curve = new Map<string, SweepRow>();
  for (const kind of CURVE_KINDS) {
    for (const s of CURVE_STRENGTHS) curve.set(`${kind}@${s}`, s === 1 ? sweeps.get(`${kind}@1`)! : sweepHabit(kind, HABIT_SEEDS, s));
  }
  const clean: CleanSweep = sweepClean(CLEAN_SEEDS);

  // --- copy / consistency checks on every review ---------------------------
  const copy: CopyFinding[] = [];
  let reviewsChecked = 0;
  const checkReviews = (source: string, reviews: Review[]) => {
    for (const r of reviews) {
      reviewsChecked++;
      for (const c of reviewChecks(r)) copy.push({ source, check: c });
    }
  };
  for (const o of outcomes) checkReviews(`case ${o.id}`, o.reviews);
  for (const [k, row] of sweeps) checkReviews(`sweep ${k}`, row.reviews);
  for (const [k, row] of curve) if (!k.endsWith('@1')) checkReviews(`curve ${k}`, row.reviews);
  checkReviews('clean control sweep', clean.reviews);

  // --- verdicts ---------------------------------------------------------------
  const failedCases = outcomes.filter((o) => o.checks.some((c) => !c.pass));
  const weakHabits = [...sweeps.values()].filter((r) => r.recall3 < BAR.recall3 || r.top1 < BAR.top1);
  const barFixed = failedCases.length === 0;
  const barCopy = copy.length === 0;
  const barSweep = weakHabits.length === 0;
  const barClean = clean.falsePositiveRate <= BAR.falsePositive;
  const ship = barFixed && barCopy && barSweep && barClean;

  // --- console ----------------------------------------------------------------
  const line = '-'.repeat(100);
  console.log(`\nTradeLens evals  (${new Date().toISOString().slice(0, 10)})\n${line}`);
  console.log(`${pad('FIXED CASE', 34)}${rpad('checks', 8)}  result`);
  for (const o of outcomes) {
    const failed = o.checks.filter((c) => !c.pass);
    console.log(`${pad(o.id, 34)}${rpad(`${o.checks.length - failed.length}/${o.checks.length}`, 8)}  ${failed.length ? 'FAIL' : 'pass'}`);
    for (const f of failed) console.log(`    x ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
  }
  console.log(line);
  console.log(`${pad('SWEEP (strength 1, 20 seeds)', 34)}${rpad('recall@3', 10)}${rpad('top-1', 8)}${rpad('precision', 11)}${rpad('ev.recall', 11)}`);
  for (const kind of HABIT_KINDS) {
    const r = sweeps.get(`${kind}@1`)!;
    const bad = r.recall3 < BAR.recall3 || r.top1 < BAR.top1;
    console.log(`${pad(kind, 34)}${rpad(pct(r.recall3), 10)}${rpad(pct(r.top1), 8)}${rpad(pctOrDash(r.precision), 11)}${rpad(pctOrDash(r.evidenceRecall), 11)}${bad ? '  <- below bar' : ''}`);
  }
  console.log(`${pad(`clean control, ${clean.seeds} seeds: false positives`, 34)}${rpad(pct(clean.falsePositiveRate), 10)}  (${clean.flagged.length} of ${clean.seeds}; bar <= ${pct(BAR.falsePositive)})`);
  console.log(line);
  console.log(`${pad('STRENGTH CURVE (recall@3 / top-1)', 34)}${CURVE_STRENGTHS.map((s) => rpad(`x${s}`, 14)).join('')}`);
  for (const kind of CURVE_KINDS) {
    console.log(`${pad(kind, 34)}${CURVE_STRENGTHS.map((s) => { const r = curve.get(`${kind}@${s}`)!; return rpad(`${pct(r.recall3)} / ${pct(r.top1)}`, 14); }).join('')}`);
  }
  console.log(line);
  console.log(`copy/consistency checks: ${reviewsChecked} reviews, ${copy.length} violation${copy.length === 1 ? '' : 's'}`);
  for (const f of copy.slice(0, 10)) console.log(`    x [${f.source}] ${f.check.name}: ${f.check.detail ?? ''}`);
  console.log(line);
  console.log(`ship bar: ${ship ? 'PASS' : 'FAIL'}   fixed cases ${barFixed ? 'ok' : 'FAIL'} | copy checks ${barCopy ? 'ok' : 'FAIL'} | sweeps ${barSweep ? 'ok' : 'FAIL'} | clean control ${barClean ? 'ok' : 'FAIL'}   (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

  // --- report -------------------------------------------------------------------
  const md: string[] = [];
  md.push('# TradeLens eval report', '');
  md.push(`Run on ${new Date().toISOString().slice(0, 10)} with \`npm run eval\` (about ${Math.round((Date.now() - t0) / 1000)} s). Fully seeded: running it again gives the same numbers.`, '');
  md.push(`## Ship bar: ${ship ? 'PASS' : 'FAIL'}`, '');
  md.push('| Criterion | Bar | Result | |', '| --- | --- | --- | --- |');
  md.push(`| Fixed cases | all pass | ${outcomes.length - failedCases.length} of ${outcomes.length} pass | ${barFixed ? 'ok' : '**FAIL**'} |`);
  md.push(`| Copy and consistency checks | 0 violations | ${copy.length} violations over ${reviewsChecked} reviews | ${barCopy ? 'ok' : '**FAIL**'} |`);
  md.push(`| Recall@3, every habit type | >= ${pct(BAR.recall3)} | lowest ${pct(Math.min(...[...sweeps.values()].map((r) => r.recall3)))} | ${[...sweeps.values()].every((r) => r.recall3 >= BAR.recall3) ? 'ok' : '**FAIL**'} |`);
  md.push(`| Top-1 accuracy, every habit type | >= ${pct(BAR.top1)} | lowest ${pct(Math.min(...[...sweeps.values()].map((r) => r.top1)))} | ${[...sweeps.values()].every((r) => r.top1 >= BAR.top1) ? 'ok' : '**FAIL**'} |`);
  md.push(`| Clean-control false positives | <= ${pct(BAR.falsePositive)} | ${pct(clean.falsePositiveRate)} (${clean.flagged.length} of ${clean.seeds} seeds) | ${barClean ? 'ok' : '**FAIL**'} |`, '');

  md.push('## What "good enough to ship" means here', '');
  md.push(
    'TradeLens is meant to name the two or three habits that cost a trader money, and to stay quiet when there is nothing to name. So the bar has four parts:',
    '',
    '1. **It finds what is there.** Every habit type the product can report is planted into synthetic traders (20 seeds each, default strength). The planted habit must be among the three shown at least 90% of the time and be the top one at least 80% of the time.',
    '2. **It does not invent habits.** 30 neutral traders (a small positive edge, no habit) must produce no habit at least 90% of the time.',
    '3. **It stays on the right side of known traps.** The September sample has three planted habits and several decoys (a busy and profitable opening half hour, the most-traded instrument being a winner, a one-off big loss, constant sizing). A separate confound case has a losing symbol that only trades in the closing window.',
    '4. **It survives bad files and writes safe copy.** BOM/CRLF, DD-MM-YYYY dates, ₹ and bracketed negatives, malformed rows, missing columns, empty files and open positions all behave. Every review, in every case, is also checked for copy rules (title length, no judgemental words, a ₹ figure in each summary) and for arithmetic that must hold (habit costs vs losses, the equity curve, totals).',
    '',
  );

  md.push('## Fixed cases', '');
  md.push('| Case | Checks | Result |', '| --- | --- | --- |');
  for (const o of outcomes) {
    const failed = o.checks.filter((c) => !c.pass);
    md.push(`| \`${o.id}\` | ${o.checks.length - failed.length}/${o.checks.length} | ${failed.length ? '**FAIL**' : 'pass'} |`);
  }
  md.push('');
  if (failedCases.length) {
    md.push('### Failures', '');
    for (const o of failedCases) {
      md.push(`**\`${o.id}\`** - ${o.title}`, '');
      for (const c of o.checks.filter((x) => !x.pass)) md.push(`- ${c.name}${c.detail ? `: ${mdEscape(c.detail)}` : ''}`);
      for (const i of o.info) md.push(`- note: ${mdEscape(i)}`);
      md.push('');
    }
  }
  md.push('### What each case asserts', '');
  for (const o of outcomes) {
    md.push(`- **\`${o.id}\`** ${o.title}.`);
    for (const i of o.info) md.push(`  - ${mdEscape(i)}`);
  }
  md.push('');

  md.push('## Sweeps: one planted habit at a time', '');
  md.push(
    `Each row is ${HABIT_SEEDS.length} seeded fixtures (a neutral trader of about 112 trades over 20 weekdays, one habit planted at default strength). Odd seeds are written as Zerodha-style executions (so the engine rebuilds the round trips), even seeds as a closed-trades file; fee-churn is always closed-trades because the charges are what is planted.`,
    '',
    '*Recall@3*: the planted habit is among the shown habits. *Top-1*: it is the first one. *Precision* and *evidence recall* are about the trades the habit cites versus the trades that were planted (where the habit was found).',
    '',
  );
  md.push('| Habit | Key expected | Recall@3 | Top-1 | Precision | Evidence recall | |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const kind of HABIT_KINDS) {
    const r = sweeps.get(`${kind}@1`)!;
    const bad = r.recall3 < BAR.recall3 || r.top1 < BAR.top1;
    md.push(`| ${kind} | \`${r.key}\` | ${pct(r.recall3)} | ${pct(r.top1)} | ${pctOrDash(r.precision)} | ${pctOrDash(r.evidenceRecall)} | ${bad ? '**below bar**' : 'ok'} |`);
  }
  md.push('');
  const missed = [...sweeps.values()].filter((r) => r.misses.length);
  if (missed.length) {
    md.push('### Seeds where the planted habit was not #1', '');
    for (const r of missed) {
      md.push(`**${r.kind}** (expected \`${r.key}\`)`, '');
      for (const m of r.misses) {
        const covers = m.covers !== null && m.covers >= 0.8 ? ` (the habit shown first cites ${pct(m.covers)} of the planted trades: a broader explanation swallowed the planted one)` : '';
        md.push(`- seed ${m.seed} (${m.mode}): shown [${m.got.join(', ') || 'nothing'}]${covers}`);
      }
      md.push('');
    }
  }

  md.push('## Clean control', '');
  md.push(`${clean.seeds} neutral traders, nothing planted: **${clean.flagged.length}** showed at least one habit (${pct(clean.falsePositiveRate)}; bar <= ${pct(BAR.falsePositive)}).`, '');
  if (clean.flagged.length) {
    for (const f of clean.flagged) md.push(`- seed ${f.seed} (${f.mode}): ${f.habits.join(', ')}`);
    md.push('');
  }

  md.push('## Strength curve', '');
  md.push('Same sweep with the planted effect scaled down (1.0 is the default strength used above). It shows where detection stops, which is the honest limit of the product: a habit that is too small or too rare to separate from luck is not reported.', '');
  md.push(`| Habit | ${CURVE_STRENGTHS.map((s) => `x${s} recall@3 / top-1`).join(' | ')} |`, `| --- | ${CURVE_STRENGTHS.map(() => '---').join(' | ')} |`);
  for (const kind of CURVE_KINDS) {
    md.push(`| ${kind} | ${CURVE_STRENGTHS.map((s) => { const r = curve.get(`${kind}@${s}`)!; return `${pct(r.recall3)} / ${pct(r.top1)}`; }).join(' | ')} |`);
  }
  md.push('');

  md.push('## Copy and consistency checks', '');
  md.push(`Applied to all ${reviewsChecked} reviews produced above. Violations: **${copy.length}**.`, '');
  if (copy.length) {
    for (const f of copy.slice(0, 40)) md.push(`- [${f.source}] ${f.check.name}: ${mdEscape(f.check.detail ?? '')}`);
    md.push('');
  }
  md.push(
    'Checks: at most 3 habits; ranks 1..n; sorted by cost; title <= 60 characters; none of `revenge, emotional, greedy, stupid, gamble, gambling, disposition, profit factor, tilt` in a habit or the verdict; the summary contains a ₹ figure; the rule is non-empty; trade ids are non-empty and exist; cost > 0; the trade net P&L adds up to the summary; habit costs <= total losses + fees; the last point of each "without habits" equity line equals actual + the habit costs so far.',
    '',
  );

  md.push('## Limits of this evidence', '');
  md.push(
    '- The fixtures are synthetic and the engine is checked against habits planted by the generators, using the detection rules written in the brief. That shows the engine finds what it is built to find; it does not show those habits are the ones that matter most to real traders.',
    '- The neutral baseline draws wins and losses independently, so some seeds contain chance patterns (for example an instrument that happens to lose). The sweeps keep those seeds in on purpose: they are part of the false-positive and top-1 numbers.',
    '- Planted effects are strong at strength 1.0 (each habit is worth roughly a quarter to a half of the month\'s losses). The strength curve shows what happens when they are smaller.',
    '- The September sample was shaped (by rejection sampling inside its generator) so that no time window or instrument looks like a leak by chance and the planted habits are separable; the answer key was computed from the fills, not from the engine.',
    '- Only the detectors in the brief are covered. Nothing here measures whether the written advice changes behaviour; that needs real users and a second month of data (the commitment check is the product\'s answer to that).',
    '',
  );
  fs.writeFileSync(REPORT, md.join('\n'));
  console.log(`wrote ${path.relative(ROOT, REPORT)}`);
  process.exit(ship ? 0 : 1);
}

main();
