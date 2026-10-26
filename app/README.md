# TradeLens

Upload a month of order history and get back the 2–3 habits that cost you the most money. Each habit comes with its ₹ cost, the trades that prove it, and one rule to try next month.

Everything runs in the browser. There is no backend, and files are never uploaded.

## Run locally

```bash
npm install          # .npmrc sets legacy-peer-deps
npm run dev          # http://localhost:5173
npm test             # unit tests (vitest)
npm run eval         # eval suite + ship bar -> evals/REPORT.md
npm run samples      # regenerate public/samples/* (deterministic)
npm run build        # type-check + production build -> dist/
```

## Deploy to Vercel

Either option works; `vercel.json` already sets the framework (Vite), the build command and the output directory (`dist`).

- **Dashboard:** create a new project, import this `app/` folder as the root directory, and deploy.
- **CLI:** run `npx vercel` from this folder, then `npx vercel --prod`.

## How it works

```
file (CSV/TSV/XLSX)
  → readTable   raw grid; picks the sheet that looks like trades
  → detect      finds the header row and guesses the format:
                  fills = broker tradebook, one row per buy/sell
                  closed-trades = one row per trade with P&L
  → parse       validates rows; rebuilds round trips from fills (scale-ins, partial
                exits, shorts, flips); estimates NSE charges when absent;
                notes open positions
  → analyze     runs 9 habit detectors, ranks candidates by marginal ₹ cost,
                keeps at most 3, explains everything it checked
```

### Habit checks (`src/engine/detectors.ts`)

| Key | What it finds |
|---|---|
| `instrument-bleed:<U>` | One underlying that keeps losing |
| `loss-streak` | Trades taken after 3 straight losses that day |
| `quick-reentry` | Re-entering the same instrument ≤15 min after a loss |
| `overtrading` | Trades beyond your usual daily count |
| `time-window:<w>` | A time of day that loses (opening / morning / midday / afternoon / closing) |
| `expiry-day` | Option trades opened on that contract's expiry day |
| `holding-losers` | Losers held ≥2× as long as winners: the extra loss compared with quick losers |
| `size-after-loss` | Sizing up ≥1.5× straight after a loss: the extra loss from the bigger size |
| `fee-churn` | Trades where charges were ≥30% of the price move |

### Ranking rules (`src/engine/analyze.ts`)

- **Ranked by marginal ₹.** Habits are chosen greedily: each habit only gets credit for trades not already explained by a higher-ranked one.
- **To be shown, a habit must:**
  - cover at least 3 trades;
  - account for at least 5% of the month's total losses;
  - be statistically worse than your other trades, for trade-set checks: Welch t ≤ −2, or ≤ −2.5 when several variants are tested.
- **Checked patterns are always reported.** Anything checked but not shown appears in the review as profitable, too small, not significant, or overlapping an earlier habit.

## Layout

```
src/engine/   pure TypeScript analysis engine (no DOM), shared by the UI, tests and evals
src/ui/       React UI
public/samples/  demo datasets + templates (see public/samples/README.md)
evals/        eval harness, fixtures and REPORT.md
tests/        vitest unit tests
scripts/      sample-data generator
```
