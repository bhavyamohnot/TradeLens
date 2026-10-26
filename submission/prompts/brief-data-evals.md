You are building the **sample data, eval suite and unit tests** for **TradeLens**, a post-trade review web app. It is a product-management intern take-home for Nubra, an Indian trading platform. The brief is: "Turn a month of order history into the two or three habits that are costing them money." The submission must also include "the evals you used to test it — how you decided the output was good enough to ship." Your work *is* that eval suite, so it has to be rigorous and honest.

## Project
- Root: `/mnt/c/Users/anuj_/Downloads/Tradelens/app`. Vite + React + TypeScript (strict). Deps are already installed: `xlsx` (SheetJS 0.20.3), `papaparse`, `vitest` 4, `tsx`. Do not add dependencies.
- Scripts already in package.json: `npm test` (vitest run), `npm run eval` (`tsx evals/run.ts`), `npm run samples` (`tsx scripts/generate-sample.ts`).
- The analysis engine in `src/engine/` is being written **concurrently by someone else**. Do NOT create or edit anything in `src/engine/` or `src/ui/`.
  - Read `src/engine/types.ts` (the data contract) and `src/engine/index.ts` (public API).
  - The eval harness should call `analyzeFile(data, fileName)` from `src/engine/index.ts`, which returns `{ table, detection, parsed, review }`.
  - Unit tests may also import these internal functions, which will exist with exactly these signatures:
    - `src/engine/symbols.ts`: `parseSymbol(symbol: string): { underlying: string; kind: InstrumentKind; expiry: string | null; strike: number | null; optionType: 'CE' | 'PE' | null }`.
      - Zerodha-style NSE symbols. Weekly options: `NIFTY2690825000CE` = NIFTY, 2026-09-08, strike 25000, CE. The month code is 1–9, O, N, D, followed by a 2-digit day.
      - Monthly options: `BANKNIFTY26SEP55000PE`. Expiry is the last Tuesday of the month for contracts from Sep 2025 onwards, so 2026-09-29.
      - Futures: `RELIANCE26SEPFUT`, with monthly expiry = last Tuesday.
      - Equity: `HDFCBANK` or `HDFCBANK-EQ`, giving underlying HDFCBANK, kind EQUITY.
      - A bare index name like `BANKNIFTY` gives underlying BANKNIFTY, kind UNKNOWN.
    - `src/engine/time.ts`: `parseTime(value: string | number | null): string | null`. Accepts `YYYY-MM-DD HH:mm[:ss]`, ISO with `T`, `DD-MM-YYYY HH:mm[:ss]`, `DD/MM/YYYY[ HH:mm[:ss]]` and Excel serial numbers. Returns `YYYY-MM-DDTHH:mm:ss`, or `YYYY-MM-DD` for date-only input, or null if invalid.
    - `src/engine/fills.ts`: `buildTrades(fills: Fill[], opts: { estimateFees: boolean }): { trades: Trade[]; openPositions: { symbol: string; qty: number; sinceTime: string | null }[] }`.
      - A trade is one position *episode* per symbol, from flat to flat. Scale-ins and partial exits stay inside one trade.
      - grossPnl = Σ sell value − Σ buy value. Shorts (sell first) are supported.
      - A fill that flips the position (e.g. long 50, sell 80) closes the episode and opens a new short of 30 at that price.
      - Episodes still open at the end are returned as openPositions and excluded from trades.
  - The engine may not be finished while you work. Write everything against the contract above. If `src/engine/analyze.ts` doesn't exist yet when you're done, still make sure your code type-checks against the declared signatures as far as possible. Then stop and report; do NOT implement engine code.

## Habit detectors the engine implements (so you can plant them correctly)
Each habit has a key. The engine ranks habits by marginal ₹ cost and shows at most 3. A habit is shown only if its cost is ≥ 5% of the month's total absolute losses, it involves ≥ 3 trades, and, for trade-set habits, those trades are significantly worse than the rest (Welch t ≤ −2, or ≤ −2.5 for multi-variant ones like instrument/time window).
- `instrument-bleed:<UNDERLYING>`: an underlying with ≥ 5 trades and negative net P&L. Its trades = all trades in it.
- `loss-streak`: trades entered on a day after ≥ 3 consecutive losing trades *that same day*.
- `quick-reentry`: a trade entered > 0 and ≤ 15 min after a *losing* trade's exit, in the same underlying on the same day.
- `overtrading`: trades whose sequence number within the day is greater than cap = max(3, median trades per active day).
- `time-window:<opening|morning|midday|afternoon|closing>`: by entry time. Windows: opening 09:15–09:45, morning 09:45–11:30, midday 11:30–13:30, afternoon 13:30–14:45, closing 14:45–15:30.
- `expiry-day`: option trades entered on that contract's own expiry date.
- `holding-losers`: needs ≥ 5 winners and ≥ 5 losers with hold times, and median loser hold ≥ 2× median winner hold. The cost is the extra loss on losers held longer than 2× the median winner hold, compared with the average quick loser.
- `size-after-loss`: a trade entered after a losing trade on the same day with qty ≥ 1.5× that underlying's median qty. Cost = extra loss attributable to the bigger size.
- `fee-churn`: trades where charges ≥ 30% of |gross P&L|. Cost = the charges paid on them.
- A pattern whose trades made money overall is reported in `review.cleared` with `reason: 'profitable'`.
- Overlapping habits: the higher-ranked one absorbs the trades, and the lower one's marginal cost is recomputed on the remaining trades.

## Deliverables

### 1. `scripts/generate-sample.ts`: the main demo dataset (deterministic, seeded PRNG, no Math.random)
A realistic month of NSE F&O + equity order history for a fictional retail trader, 1–30 Sep 2026.
- **Trading days:** weekdays only. Skip Monday 14 Sep (treat as a market holiday).
- **Format:** Zerodha-Console-style tradebook CSV, one row per execution, with header:
  `symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time`
  - `trade_type` is `buy`/`sell`.
  - `trade_date` is `YYYY-MM-DD`; `order_execution_time` is `YYYY-MM-DDTHH:mm:ss`.
  - `segment` is FO or EQ; `exchange` NSE; isin is blank for F&O.
  - There is **no charges column**, matching the real tradebook. The engine estimates charges.
- **Outputs:**
  - `public/samples/sept-2026-tradebook.csv`
  - `public/samples/sept-2026-tradebook.xlsx` (same data, one sheet "tradebook", via SheetJS)
  - `public/samples/sept-2026-tradebook.answer-key.json`
  - `public/samples/template-tradebook.csv` (header + 4 example rows: one round trip in an option and one in a stock)
  - `public/samples/template-closed-trades.csv` (header `id,symbol,entry_time,exit_time,pnl,fees,quantity` + 3 example rows)
- **Instruments:**
  - NIFTY weekly options, expiring every Tuesday: Sep 1, 8, 15, 22, 29. The 29 Sep monthly uses monthly format `NIFTY26SEP...`; the others use weekly format `NIFTY26908...`. Lot 65, NIFTY ~25,000, strikes in steps of 50, premiums ₹60–₹250.
  - BANKNIFTY monthly options (`BANKNIFTY26SEP55000CE`, expiry 29 Sep). Lot 30, ~55,000, strikes in steps of 100.
  - RELIANCE futures (`RELIANCE26SEPFUT`, lot 500, ~₹1,400).
  - Equity intraday: HDFCBANK, INFY.
  - Quantities are multiples of the lot size. Prices are realistic and keep 2 decimals (options tick 0.05).
- **Size:** about 150–180 round trips and 350–450 fills. Include:
  - ~15% scale-in entries (2 buy fills);
  - ~15% partial exits (2–3 sell fills);
  - ≥ 3 short-first trades (sell then buy back);
  - exactly 1 position left **open** on 30 Sep (bought 15:20, never closed);
  - fills of one order sharing an `order_id`.
- **Planted habits** (keep their trade sets disjoint so ground truth is unambiguous):
  1. **Expiry-day option buying:** on each Tuesday, 4–6 buys of the *expiring* NIFTY weekly. ~20% win rate. Total gross ≈ −₹28,000.
  2. **Quick re-entry after a loss:** on non-Tuesdays, ~12 instances. After a losing trade, the trader re-enters the same underlying 2–10 min later at the *same* size. Re-entries win ~25%. Total gross on re-entry trades ≈ −₹14,000.
  3. **Holding losers:** on ordinary trades (non-Tuesday, not re-entries), winners are held 6–20 min and losers 45–120 min. Make long-held losers ~2.5× bigger than the few quick losers. Excess cost ≈ ₹10,000.
- **Decoys** (must NOT be flagged):
  - D1: the opening window (09:15–09:45) is busy and clearly profitable.
  - D2: RELIANCE futures are the most-traded instrument by turnover and net profitable.
  - D3: one single large BANKNIFTY loss (≈ −₹6,000) on an ordinary day, as a one-off (n = 1).
  - D4: constant size per underlying everywhere except where planted (no size-after-loss).
  - D5: no other quick re-entries after losses (keep other gaps after a loss > 25 min); no day with > 3 straight losses outside the planted sets; ≤ 8 trades per day, and the same distribution on every day so overtrading doesn't fire.
- **Ordinary trades** (everything not planted) should be net profitable, ≈ +₹15,000 to +₹25,000 gross. That way the headline reads "these habits turned a profitable month into a loss".
- **Answer key JSON** (computed from the generated fills, independent of the engine):
  - `totals: { roundTrips, fills, grossPnl }` (gross from fills, excluding the open position);
  - `openPosition: { symbol, qty }`;
  - `planted: [{ key: 'expiry-day' | 'quick-reentry' | 'holding-losers', expectedRank, trades: [{ symbol, entryTime }], grossPnl }]`, with expectedRank by size of planted cost;
  - `decoys: [{ key, note }]`, with keys such as `time-window:opening`, `instrument-bleed:RELIANCE`, `size-after-loss`, `overtrading`, `loss-streak`.
- Also write `public/samples/README.md`. Cover what the dataset is, what's planted, what the decoys are, and that it is synthetic and fictional.

### 2. `evals/generators.ts`: parametric, seeded fixture generators
- A baseline "neutral trader" generator:
  - ~100–140 closed trades over ~20 weekdays, 4–6 underlyings (mix of options/futures/equity symbols);
  - entries spread across all time windows, holds 5–40 min for winners and losers alike, constant size per underlying;
  - ≤ 6 trades/day with a stable distribution, gaps after losses > 25 min, no expiry-day option trades, a small positive edge.
- Planting functions, one per habit key above, each with a `strength` parameter. Each plants the habit on top of or within the baseline and returns the planted trade ids. For `instrument-bleed` and `time-window`, plant a specific variant.
- Two output writers:
  - closed-trades CSV (`id,symbol,entry_time,exit_time,pnl,fees,quantity`);
  - fills CSV in the Zerodha-style format above, which decomposes each closed trade into buy/sell fills. Use it for some cases so the FIFO path is exercised.

### 3. `evals/cases.ts` + `evals/run.ts`: the eval harness
`npm run eval` runs everything, prints a readable table and writes `evals/REPORT.md` with date, per-case results and sweep metrics. It exits 1 if the **ship bar** fails.

**Fixed cases** (each with explicit assertions):
1. `brief-example`: the provided `public/samples/tradelens-example.xlsx`. It has a title row and a blank row before the header, and pnl is gross with a fees column. Expect:
   - 60 trades; gross −2,990; fees 2,100; net −5,090;
   - habit #1 = `instrument-bleed:BANKNIFTY` with cost 9,100, and no other habit with cost > 1,000;
   - `quick-reentry` in `cleared` with reason `profitable` (its trades net +650);
   - summary.longestLosingStreak = 20.
2. `sept-2026-tradebook` (CSV) and `sept-2026-tradebook-xlsx`: read the answer key.
   - The top-3 habit keys equal the planted set, and #1 equals the planted rank-1.
   - No decoy key appears in habits.
   - Trades = roundTrips; Σ gross = answer-key gross ±₹1; exactly one open position noted.
   - Charges estimated (`parsed.coverage.fees === 'estimated'`).
3. One case per habit type (9 cases) from the generators at a fixed seed. Expect habit #1 = the planted key.
4. `clean-control`: the baseline only. Expect `habits.length === 0`.
5. `confound-symbol-vs-time`: a losing underlying traded only in the closing window, with every other closing-window trade profitable. Expect #1 = `instrument-bleed:<that>`, and `time-window:closing` not in habits.
6. Robustness cases:
   - net-only P&L column (`net_pnl`, no fees): fees coverage 'included'; parse works;
   - no timestamps: timing habits appear in `review.unavailable`; instrument-bleed still works;
   - DD-MM-YYYY dates with ₹, comma and parenthesised negatives in pnl;
   - UTF-8 BOM + CRLF;
   - 5 malformed rows mixed in: they appear in `parsed.rejected` and the rest still analyses;
   - a file with buy/sell rows but no price column: `detect` returns format null or low confidence with a problem message, and it must not crash;
   - an empty file and a header-only file: clean error, no crash;
   - a tradebook with an open position: excluded and noted.

**Sweeps** (the statistical part of the ship bar):
- For each habit type, 20 seeds at default strength: recall@3 (planted key is among habits) and top-1 accuracy.
- Clean control, 30 seeds: false-positive rate = share of seeds where any habit is shown.
- Report each metric per habit type. Also add a strength curve for 2–3 habit types (strength 0.25/0.5/1.0), which shows where detection starts to fail.

**Copy and consistency checks**, applied to every review produced in any case:
- Each habit:
  - title ≤ 60 chars;
  - no banned words (case-insensitive): `revenge, emotional, greedy, stupid, gamble, gambling, disposition, profit factor, tilt`;
  - summary contains `₹`; rule is non-empty; tradeIds non-empty; cost > 0;
  - every tradeId exists in review.trades.
- Habits are sorted by cost descending, ranks are 1..n, and there are ≤ 3.
- Σ trade netPnl equals summary.netPnl (±₹1). Σ habit costs ≤ total absolute losses + total fees.
- The final `withoutHabits[i]` of the equity series equals final actual + Σ costs of habits 0..i (±₹1).

**Ship bar** (fail = exit 1):
- all fixed cases pass;
- every copy/consistency check passes;
- recall@3 ≥ 90% and top-1 ≥ 80% for every habit type;
- clean-control FP rate ≤ 10%.

### 4. `tests/*.test.ts` (vitest)
- `parseSymbol`: the formats above, including weekly month codes O/N/D and the last-Tuesday monthly expiry.
- `parseTime`: every accepted format, invalid dates (31-02-2026), Excel serials.
- `buildTrades`: simple long; short-first; scale-in; partial exit; flip through zero; open position left over; and two symbols interleaved. Give exact expected gross values.
- An end-to-end check of the example xlsx totals (the same numbers as eval case 1).

## Done when
- `npm run samples` regenerates the sample files deterministically (running it twice gives identical bytes).
- `npx tsc --noEmit -p .` shows no errors in your files. Errors that exist only because engine modules are missing are acceptable; list them.
- If the engine exists by the time you finish: run `npm test` and `npm run eval`, and report the actual output honestly. Do not loosen thresholds or assertions to make things pass. If something fails, report what failed and why you think so (generator issue vs engine issue), and fix only generator-side bugs.
- Report back: the files created; sample stats (round trips, fills, gross, planted costs); and test/eval results or the reason they couldn't run.
