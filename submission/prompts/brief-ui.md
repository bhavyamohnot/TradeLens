You are building the user interface of **TradeLens**, a post-trade review web app. It is a product-management intern take-home for Nubra, an Indian trading platform. The brief is: "Most retail traders never review their own trades. Turn a month of order history into the two or three habits that are costing them money." Reviewers judge problem framing and clarity more than polish. The UI must still be clean, credible and easy to click through for someone with no market knowledge.

## Project
- Root: `/mnt/c/Users/anuj_/Downloads/Tradelens/app`. Vite 8, React 19, TypeScript (strict). Deps are already installed: react, react-dom, papaparse, xlsx (SheetJS 0.20.3), vitest, tsx. Do **not** add dependencies (no UI kits, chart libs, routers or state libs). Plain CSS in `src/ui/*.css` or one `src/ui/app.css` is fine.
- Use `npm install --legacy-peer-deps` if you ever need to reinstall. An `.npmrc` already sets this.
- The analysis engine lives in `src/engine/` and is being written **concurrently by someone else**. Do NOT edit anything in `src/engine/`. Read `src/engine/types.ts` (the full data contract) and `src/engine/index.ts` (the public API) first. Import only from `../engine` (the index).
  - `readTable(data: ArrayBuffer | Uint8Array | string, fileName: string, sheet?: string): RawTable` reads CSV/TSV/XLSX/XLS. If no sheet is given it picks the best one.
  - `detect(table): Detection` guesses the format (`fills` = raw broker tradebook rows, or `closed-trades`) and the column mapping. If `confidence === 'low'` or `format === null`, show the column-mapping step.
  - `FIELD_LABELS: Record<FieldKey, string>` and `FORMAT_FIELDS: Record<InputFormat, { required: FieldKey[]; optional: FieldKey[] }>` drive the mapping UI.
  - `parse(table, detection): ParseResult` validates rows and builds round-trip trades. It may throw an `Error` with a user-readable message.
  - `analyze(parsed): Review` gives the summary, up to 3 ranked habits, cleared checks, unavailable checks, an equity series and notes.
  - `checkCommitment(commitment, review): CommitmentCheck` is used for the "habit you committed to last time" banner.
  - `formatInr`, `formatSignedInr`, `formatDate`, `formatDateTime` already exist in `src/engine/format.ts`. Use them for every number shown.
- Until the engine is finished, `analyze` etc. may not exist yet, so imports will fail. Develop against a hand-written mock `Review` in `src/ui/mockReview.ts` that is typed against `types.ts`. Make it realistic: 3 habits, several cleared items, 1 unavailable item, notes, ~40 trades and an equity series. Wire the real engine calls in the app code anyway.
- Create `index.html` (root), `src/main.tsx` and `src/ui/**`. Title: "TradeLens — find the habits costing you money". Add a simple SVG favicon in `public/favicon.svg`.

## Sample files (served from `public/samples/`, produced by another teammate; may not exist yet)
- `/samples/sept-2026-tradebook.csv` is the main demo: a month of raw broker fills. Label it "Sample: a month of F&O order history".
- `/samples/tradelens-example.xlsx` is the closed-trade example from the brief. Label it "Sample: closed-trade sheet".
- `/samples/template-tradebook.csv` and `/samples/template-closed-trades.csv` are downloadable templates.
Load samples with `fetch(...).then(r => r.arrayBuffer())` and run them through the same pipeline as uploads.

## Flow (single page, no router; keep the state in App)
1. **Landing.** One clear promise, e.g. "Find the 2–3 habits that cost you money last month." Add one supporting line: upload a month of order history, get back the few habits worth fixing, each with the ₹ it cost and one rule to try.
   - A big drag-and-drop / click upload zone (CSV, TSV, XLSX, XLS; reject other types and files > 5 MB with a friendly message).
   - Two sample buttons.
   - A collapsible "What file do I need?" section. It explains that a broker tradebook export works (e.g. Zerodha Console → Reports → Tradebook → download CSV/XLSX), as does a sheet with one row per closed trade. Link the two templates.
   - A privacy line: "Your file never leaves this browser."
   - Three tiny "how it works" steps: Upload → we rebuild your round-trip trades → you get the habits ranked by ₹ cost.
2. **Column check (only when needed, or when the user clicks "Check columns" on the review).**
   - Show the detected format (radio: "Order history — one row per buy/sell" vs "Closed trades — one row per trade with P&L").
   - Dropdowns mapping each FieldKey in FORMAT_FIELDS[format] to a header. Mark required ones and show `detection.problems`.
   - For closed-trades, a "P&L is before charges / after charges" toggle (`pnlIsNet`).
   - A sheet picker if `table.sheetNames.length > 1` (re-run `readTable` with that sheet, then `detect`).
   - A preview of the first 5 data rows, and an "Analyse" button. Build a modified `Detection` object and call `parse`.
3. **Review** is a single narrative column (max-width ~760px). It must NOT feel like a dashboard. Order matters:
   a. **Header:** file name, period label, trade count. Actions: "Check columns", "Download review (.md)", "Print / save PDF", "New review".
   b. **Commitment banner**, if a commitment exists in localStorage (`tradelens.commitment.v1`, a `Commitment` JSON) and its `baselinePeriod` differs from this review's `summary.periodLabel`. Show `checkCommitment(...).text`, styled by status.
   c. **Verdict:** `review.verdict` in large type. Under it, three compact figures: Net P&L, Charges, and "If you'd fixed habit #1". That last one is the final `withoutHabits[0]` value of the equity series, formatted signed.
   d. **Habit cards, ranked 1–3.** Each card shows:
      - rank number, `title`, the ₹ `cost` big and red-ish with the label "cost you", and `summary`;
      - `evidence` bullets and a confidence badge (high/medium/low), with a tooltip/explainer: "how sure we are, based on how many trades and how consistent the pattern is";
      - a **trade strip**: one small dot per trade in chronological order (all trades), with this habit's trades emphasised and coloured win/loss and the others faint;
      - a "Rule to try next month" box with `rule`, and a "Commit to this rule" button that stores a `Commitment` (baselineCost = cost, baselinePeriod = summary.periodLabel). Show a committed state, one commitment at a time;
      - an expandable "See the N trades" table: entry time, symbol, qty, hold, net P&L;
      - if `overlapsWith` is non-empty, one muted line: "Also explains: …". Map keys to cleared titles when possible, else humanise the key.
      If `habits.length === 0`, show a calm empty state: "No costly habit stood out this month" plus the cleared list.
   e. **One chart:** cumulative net P&L line (actual), plus dashed lines for "without habit #1", and "without #1–#2" etc. from `equity[].withoutHabits`. Use a hand-written responsive SVG with a zero line, start/end labels and a legend. No library. Keep it small (about 220px tall).
   f. **"Checked — not costing you money"**: `cleared` items (title + detail). Emphasise `reason === 'profitable'` ones, since they show the tool doesn't invent problems.
   g. **"Couldn't check"**: `unavailable` items with reasons.
   h. **Month at a glance**: one compact row or grid of secondary stats (trades, trading days, win rate, avg win, avg loss, max drawdown, best day, worst day, longest losing streak, gross P&L). Small type, below the habits on purpose.
   i. **Data notes**: `review.notes` (warn vs info), rejected-row count, open positions excluded, and a charges-estimated note if present.
   j. **All trades**: a collapsible table with a filter chip per habit.
4. **Markdown export** (`src/ui/exportMarkdown.ts`): a clean, shareable review containing the verdict, habits with cost/evidence/rule, cleared, unavailable, summary stats and notes. Add **print CSS** so "Print / save PDF" gives a tidy document (hide buttons, expand habit cards, no dark backgrounds).

## Visual direction
Professional Indian fintech, calm and confident. Inspiration: Nubra's own deck style (deep navy hero, white body, crisp blue accent). Do not use any Nubra logo or claim to be Nubra.
- Tokens on `:root`:
  - `--ink #0B1220`, `--ink-2 #334155`, `--muted #64748B`, `--line #E2E8F0`
  - `--bg #F8FAFC`, `--card #FFFFFF`
  - `--accent #1D6FE8`, `--accent-soft #E8F0FD`
  - `--loss #C0262D`, `--loss-soft #FDECEC`, `--gain #0F8A4B`, `--gain-soft #E7F6EE`
  - `--navy #0A1630`
- Landing hero on a navy band, with a subtle radial blue/teal glow like the brief's PDF header. Review pages on a light background.
- Font: Inter via Google Fonts (400/500/600/700), with `font-variant-numeric: tabular-nums` on all figures.
- Generous spacing, 12px radius cards, 1px borders, very light shadows. No emoji.
- Mobile first: must work at 375px wide with no horizontal scroll. Tables scroll inside their own container.
- Accessibility: real buttons and labels, focus rings, colour is never the only signal (use +/− signs and words too), and the chart has an aria-label summary.
- Copy rules: plain English, second person, no jargon in headings ("profit factor", "disposition effect", "drawdown" only in the small stats section). Never moralise or guess emotions: never use the word "revenge", never say "you were emotional". Use INR formatting everywhere via the format helpers.

## Done when
- `npm run build` passes (tsc strict + vite build) with no type errors in your files.
- In a browser, all three paths work at 1440px and 375px: (1) the sample tradebook, (2) the example xlsx, (3) uploading a file from disk.
  - Use Playwright from `/tmp/claude-1000/-mnt-c-Users-anuj-/d46de663-771b-4db6-ba24-7f00845bcf83/scratchpad/pw` (node + `playwright` installed there). Launch with `chromium.launch({ executablePath: '/home/anuj/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' })` against `npx vite preview --port 4173` or `npx vite --port 5173`. Save screenshots in that scratchpad folder.
  - If the engine (`src/engine/analyze.ts`) or the sample files don't exist yet when you're done, test with the mock and say so clearly in your report. Do not write engine code.
- Report back:
  - the files you created;
  - screenshot paths;
  - anything in the engine contract that was awkward or missing, with a concrete proposed change;
  - anything you could not verify.
