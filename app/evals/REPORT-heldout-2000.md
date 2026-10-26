# TradeLens eval report

Run on 2026-10-26 with `npm run eval` (about 3 s). Fully seeded: running it again gives the same numbers.

## Ship bar: PASS

| Criterion | Bar | Result | |
| --- | --- | --- | --- |
| Fixed cases | all pass | 22 of 22 pass | ok |
| Copy and consistency checks | 0 violations | 0 violations over 350 reviews | ok |
| Recall@3, every habit type | >= 90% | lowest 95% | ok |
| Top-1 accuracy, every habit type | >= 80% | lowest 85% | ok |
| Clean-control false positives | <= 10% | 3% (1 of 30 seeds) | ok |

## What "good enough to ship" means here

TradeLens is meant to name the two or three habits that cost a trader money, and to stay quiet when there is nothing to name. So the bar has four parts:

1. **It finds what is there.** Every habit type the product can report is planted into synthetic traders (20 seeds each, default strength). The planted habit must be among the three shown at least 90% of the time and be the top one at least 80% of the time.
2. **It does not invent habits.** 30 neutral traders (a small positive edge, no habit) must produce no habit at least 90% of the time.
3. **It stays on the right side of known traps.** The September sample has three planted habits and several decoys (a busy and profitable opening half hour, the most-traded instrument being a winner, a one-off big loss, constant sizing). A separate confound case has a losing symbol that only trades in the closing window.
4. **It survives bad files and writes safe copy.** BOM/CRLF, DD-MM-YYYY dates, ₹ and bracketed negatives, malformed rows, missing columns, empty files and open positions all behave. Every review, in every case, is also checked for copy rules (title length, no judgemental words, a ₹ figure in each summary) and for arithmetic that must hold (habit costs vs losses, the equity curve, totals).

## Fixed cases

| Case | Checks | Result |
| --- | --- | --- |
| `brief-example` | 10/10 | pass |
| `sept-2026-tradebook` | 7/7 | pass |
| `sept-2026-tradebook-xlsx` | 7/7 | pass |
| `habit-instrument-bleed` | 1/1 | pass |
| `habit-loss-streak` | 1/1 | pass |
| `habit-quick-reentry` | 1/1 | pass |
| `habit-overtrading` | 1/1 | pass |
| `habit-time-window` | 1/1 | pass |
| `habit-expiry-day` | 1/1 | pass |
| `habit-holding-losers` | 1/1 | pass |
| `habit-size-after-loss` | 1/1 | pass |
| `habit-fee-churn` | 1/1 | pass |
| `clean-control` | 1/1 | pass |
| `confound-symbol-vs-time` | 2/2 | pass |
| `robust-net-only-pnl` | 5/5 | pass |
| `robust-no-timestamps` | 3/3 | pass |
| `robust-dd-mm-rupee-formats` | 4/4 | pass |
| `robust-bom-crlf` | 4/4 | pass |
| `robust-malformed-rows` | 4/4 | pass |
| `robust-no-price-column` | 4/4 | pass |
| `robust-empty-files` | 4/4 | pass |
| `robust-open-position` | 3/3 | pass |

### What each case asserts

- **`brief-example`** Brief example workbook (title row, blank row, gross P&L + fees).
  - independent recount of the longest losing streak in file order: 21
- **`sept-2026-tradebook`** September 2026 sample tradebook (CSV) vs answer key.
  - habits: expiry-day (30,130.52), quick-reentry (15,932.07), holding-losers (11,915.54)
  - planted-rank order of the habits found: 123 (123 = same order as expectedRank)
- **`sept-2026-tradebook-xlsx`** September 2026 sample tradebook (XLSX) vs answer key.
  - habits: expiry-day (30,130.52), quick-reentry (15,932.07), holding-losers (11,915.54)
  - planted-rank order of the habits found: 123 (123 = same order as expectedRank)
- **`habit-instrument-bleed`** Planted instrument-bleed (seed 1, fills file).
  - 22 trades planted; habit #1 cites 22, 22 of them planted
- **`habit-loss-streak`** Planted loss-streak (seed 1, closed file).
  - 22 trades planted; habit #1 cites 22, 22 of them planted
- **`habit-quick-reentry`** Planted quick-reentry (seed 1, fills file).
  - 10 trades planted; habit #1 cites 10, 10 of them planted
- **`habit-overtrading`** Planted overtrading (seed 1, closed file).
  - 15 trades planted; habit #1 cites 15, 15 of them planted
- **`habit-time-window`** Planted time-window (seed 1, fills file).
  - 37 trades planted; habit #1 cites 37, 37 of them planted
- **`habit-expiry-day`** Planted expiry-day (seed 1, fills file).
  - 16 trades planted; habit #1 cites 16, 16 of them planted
- **`habit-holding-losers`** Planted holding-losers (seed 1, closed file).
  - 49 trades planted; habit #1 cites 49, 49 of them planted
- **`habit-size-after-loss`** Planted size-after-loss (seed 1, fills file).
  - 13 trades planted; habit #1 cites 13, 13 of them planted
- **`habit-fee-churn`** Planted fee-churn (seed 1, closed file).
  - 30 trades planted; habit #1 cites 30, 30 of them planted
- **`clean-control`** Neutral trader, nothing planted (seed 1).
  - net 21,628.85 over 112 trades
- **`confound-symbol-vs-time`** A losing symbol traded only in the closing window; all other closing trades win.
  - habits: instrument-bleed:INFY (9,775.4)
- **`robust-net-only-pnl`** Net-only P&L column (net_pnl), no fees column.
- **`robust-no-timestamps`** No entry/exit timestamps.
  - unavailable: loss-streak, quick-reentry, overtrading, time-window, expiry-day, holding-losers, size-after-loss
- **`robust-dd-mm-rupee-formats`** DD-MM-YYYY dates; pnl as ₹1,234.50 and (₹450.00).
- **`robust-bom-crlf`** UTF-8 BOM and CRLF line endings.
- **`robust-malformed-rows`** Five malformed rows mixed in.
- **`robust-no-price-column`** Buy/sell rows but no price column.
- **`robust-empty-files`** Empty file and header-only file.
- **`robust-open-position`** Tradebook with a position still open.

## Sweeps: one planted habit at a time

Each row is 20 seeded fixtures (a neutral trader of about 112 trades over 20 weekdays, one habit planted at default strength). Odd seeds are written as Zerodha-style executions (so the engine rebuilds the round trips), even seeds as a closed-trades file; fee-churn is always closed-trades because the charges are what is planted.

*Recall@3*: the planted habit is among the shown habits. *Top-1*: it is the first one. *Precision* and *evidence recall* are about the trades the habit cites versus the trades that were planted (where the habit was found).

| Habit | Key expected | Recall@3 | Top-1 | Precision | Evidence recall | |
| --- | --- | --- | --- | --- | --- | --- |
| instrument-bleed | `instrument-bleed:HDFCBANK` | 100% | 100% | 100% | 100% | ok |
| loss-streak | `loss-streak` | 95% | 85% | 100% | 98% | ok |
| quick-reentry | `quick-reentry` | 100% | 100% | 100% | 99% | ok |
| overtrading | `overtrading` | 100% | 100% | 100% | 100% | ok |
| time-window | `time-window:midday` | 100% | 100% | 100% | 100% | ok |
| expiry-day | `expiry-day` | 100% | 100% | 100% | 100% | ok |
| holding-losers | `holding-losers` | 100% | 100% | 100% | 100% | ok |
| size-after-loss | `size-after-loss` | 100% | 95% | 100% | 97% | ok |
| fee-churn | `fee-churn` | 100% | 90% | 100% | 99% | ok |

### Seeds where the planted habit was not #1

**loss-streak** (expected `loss-streak`)

- seed 2008 (closed): shown [instrument-bleed:RELIANCE, loss-streak]
- seed 2011 (fills): shown [nothing]
- seed 2019 (fills): shown [instrument-bleed:RELIANCE, loss-streak]

**size-after-loss** (expected `size-after-loss`)

- seed 2007 (fills): shown [instrument-bleed:INFY, size-after-loss]

**fee-churn** (expected `fee-churn`)

- seed 2015 (closed): shown [time-window:opening, fee-churn]
- seed 2020 (closed): shown [loss-streak, fee-churn]

## Clean control

30 neutral traders, nothing planted: **1** showed at least one habit (3%; bar <= 10%).

- seed 2013 (fills): loss-streak (3,774.05)

## Strength curve

Same sweep with the planted effect scaled down (1.0 is the default strength used above). It shows where detection stops, which is the honest limit of the product: a habit that is too small or too rare to separate from luck is not reported.

| Habit | x0.25 recall@3 / top-1 | x0.5 recall@3 / top-1 | x1 recall@3 / top-1 |
| --- | --- | --- | --- |
| instrument-bleed | 0% / 0% | 10% / 10% | 100% / 100% |
| quick-reentry | 0% / 0% | 0% / 0% | 100% / 100% |
| expiry-day | 0% / 0% | 20% / 20% | 100% / 100% |

## Copy and consistency checks

Applied to all 350 reviews produced above. Violations: **0**.

Checks: at most 3 habits; ranks 1..n; sorted by cost; title <= 60 characters; none of `revenge, emotional, greedy, stupid, gamble, gambling, disposition, profit factor, tilt` in a habit or the verdict; the summary contains a ₹ figure; the rule is non-empty; trade ids are non-empty and exist; cost > 0; the trade net P&L adds up to the summary; habit costs <= total losses + fees; the last point of each "without habits" equity line equals actual + the habit costs so far.

## Limits of this evidence

- The fixtures are synthetic and the engine is checked against habits planted by the generators, using the detection rules written in the brief. That shows the engine finds what it is built to find; it does not show those habits are the ones that matter most to real traders.
- The neutral baseline draws wins and losses independently, so some seeds contain chance patterns (for example an instrument that happens to lose). The sweeps keep those seeds in on purpose: they are part of the false-positive and top-1 numbers.
- Planted effects are strong at strength 1.0 (each habit is worth roughly a quarter to a half of the month's losses). The strength curve shows what happens when they are smaller.
- The September sample was shaped (by rejection sampling inside its generator) so that no time window or instrument looks like a leak by chance and the planted habits are separable; the answer key was computed from the fills, not from the engine.
- Only the detectors in the brief are covered. Nothing here measures whether the written advice changes behaviour; that needs real users and a second month of data (the commitment check is the product's answer to that).
