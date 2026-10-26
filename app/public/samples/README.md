# TradeLens sample data

Everything in this folder is **synthetic and fictional**. The "trader" does not exist, the prices are
made up (they are only shaped like NSE data), and nothing here is a record of anyone's real orders.

| File | What it is |
| --- | --- |
| `sept-2026-tradebook.csv` | A month (1-30 Sep 2026) of executions in Zerodha-Console tradebook layout, one row per fill. No charges column, like the real thing, so TradeLens estimates charges. |
| `sept-2026-tradebook.xlsx` | The same rows as an Excel workbook (sheet `tradebook`). |
| `sept-2026-tradebook.answer-key.json` | What was planted and what must not be flagged. Computed from the fills, not from the analysis engine. |
| `template-tradebook.csv` | Header plus two example round trips, for people preparing their own file. |
| `template-closed-trades.csv` | The simpler "one row per closed trade" layout (`id,symbol,entry_time,exit_time,pnl,fees,quantity`). |
| `tradelens-example.xlsx` | The small 60-trade example from the brief (title row, blank row, then the table). |

Regenerate the first five with `npm run samples`. The generator is seeded, so the files are byte-for-byte
identical every time.

## What is in the month

158 round trips and 388 fills across NIFTY weekly options (expiring every Tuesday: 1, 8, 15, 22 and
29 Sep), BANKNIFTY monthly options, RELIANCE futures, and HDFCBANK / INFY intraday. 14 Sep is treated as a
market holiday. Some trades scale in (two buys), some exit in parts (two or three sells), five are short-first,
and the month ends with one HDFCBANK position bought at 15:20 on 30 Sep and never closed (TradeLens should
set it aside and say so). Quantity is constant per underlying.

## The three planted habits

The expiry-day and re-entry trades are disjoint from each other and from everything ordinary; the
holding-losers set is the long-held ordinary losers (including the loser that each re-entry follows).

1. **Expiry-day option buying** (-Rs 27,995 gross). Every Tuesday the trader buys five of the NIFTY weekly
   option that expires that same day (25 trades). One in five wins.
2. **Quick re-entry after a loss** (-Rs 14,010 gross). On 12 non-Tuesdays, a loss is followed 2-10
   minutes later by a fresh trade in the same instrument at the same size. About a quarter of those win.
3. **Holding losers** (about Rs 9,100 of extra loss compared with the quicker losses, 37 trades). Ordinary winners are
   held 6-20 minutes; ordinary losers 45-105 minutes, and about 2.5x the size of the few quick ordinary losers.

Everything else is ordinary trading that makes about +Rs 22,100 gross, so the headline of
the review is: these habits turned a profitable month into a loss (-Rs 19,910 gross, -Rs 40,248 after estimated charges).

## The decoys (a good review must NOT flag these)

* **Opening half hour (9:15-9:45)** is the busiest window and clearly profitable.
* **RELIANCE futures** have the highest turnover and are net profitable.
* **One big BANKNIFTY loss** (about -Rs 6,000) is a one-off, not a leaking instrument.
* **Position size** is constant per underlying, so there is no "sizing up after a loss".
* **Overtrading and loss streaks**: no day has more than 8 trades (the typical day), and no day has three losers
  in a row outside the planted sets.

The `decoys` list in the answer key names the habit keys that must not appear.
