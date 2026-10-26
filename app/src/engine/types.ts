// Shared contract between the analysis engine, the UI and the eval harness.
// All money values are INR. All timestamps are exchange-local wall-clock
// strings "YYYY-MM-DDTHH:mm:ss" (IST, no offset) so analysis never depends on
// the viewer's time zone.

export type Side = 'BUY' | 'SELL';
export type InstrumentKind = 'OPTION' | 'FUTURE' | 'EQUITY' | 'UNKNOWN';

/** One execution row from a broker tradebook / order history. */
export interface Fill {
  row: number; // 1-based source row number, for error messages
  symbol: string;
  side: Side;
  qty: number; // always positive
  price: number;
  time: string; // local ISO
  fees: number | null; // null when the file has no charges column
  orderId: string | null;
}

/** A closed round trip: position opened from flat and returned to flat. */
export interface Trade {
  id: string;
  symbol: string;
  underlying: string; // e.g. "NIFTY" for NIFTY2690924500CE
  kind: InstrumentKind;
  expiry: string | null; // "YYYY-MM-DD" when known (options/futures)
  direction: 'LONG' | 'SHORT' | 'UNKNOWN';
  qty: number; // max absolute position size during the trade
  entryTime: string | null;
  exitTime: string | null;
  holdMinutes: number | null;
  grossPnl: number | null; // null when only net P&L was provided
  fees: number;
  feesSource: 'reported' | 'estimated' | 'included' | 'none';
  netPnl: number;
  sourceRows: number[];
}

export type InputFormat = 'fills' | 'closed-trades';

export type FieldKey =
  | 'symbol'
  | 'side'
  | 'qty'
  | 'price'
  | 'time'
  | 'date'
  | 'fees'
  | 'orderId'
  | 'tradeId'
  | 'entryTime'
  | 'exitTime'
  | 'pnl'
  | 'netPnl'
  | 'expiry';

/** Column index per field (-1 = not mapped). */
export type ColumnMap = Partial<Record<FieldKey, number>>;

/** Raw table after reading a CSV/XLSX file, before interpretation. */
export interface RawTable {
  fileName: string;
  sheetNames: string[]; // [] for CSV
  sheet: string | null;
  rows: (string | number | null)[][]; // every row of the chosen sheet, as read
}

/** What the engine guessed about the file; the UI lets the user correct it. */
export interface Detection {
  headerRow: number; // 0-based index into RawTable.rows
  headers: string[];
  format: InputFormat | null; // null = could not tell
  columns: ColumnMap;
  pnlIsNet: boolean; // closed-trades only: P&L column already net of charges
  confidence: 'high' | 'low'; // low => UI should show the column-mapping step
  problems: string[]; // human-readable reasons when format is null or confidence is low
}

export interface Note {
  level: 'info' | 'warn';
  text: string;
}

export interface ParseResult {
  format: InputFormat;
  trades: Trade[];
  rejected: { row: number; reason: string }[];
  openPositions: { symbol: string; qty: number; sinceTime: string | null }[];
  notes: Note[];
  coverage: {
    timestamps: boolean; // every trade has entry + exit time
    fees: 'reported' | 'estimated' | 'mixed' | 'included' | 'none';
    quantity: boolean;
  };
}

export type HabitId =
  | 'instrument-bleed'
  | 'loss-streak'
  | 'quick-reentry'
  | 'overtrading'
  | 'time-window'
  | 'expiry-day'
  | 'holding-losers'
  | 'size-after-loss'
  | 'fee-churn';

export type Confidence = 'high' | 'medium' | 'low';

/** A habit that measurably cost money this period. */
export interface Habit {
  key: string; // stable id incl. variant, e.g. "instrument-bleed:BANKNIFTY", "time-window:closing"
  id: HabitId;
  rank: number; // 1-based, by marginal cost
  title: string; // plain language, <= 60 chars, no jargon
  summary: string; // one sentence with the ₹ figure
  cost: number; // marginal ₹ lost (positive number), after removing overlap with higher-ranked habits
  standaloneCost: number; // ₹ lost if considered alone
  tradeIds: string[]; // trades that make up the habit (evidence)
  evidence: string[]; // 2-4 short factual bullets
  rule: string; // one concrete guardrail to try next month
  confidence: Confidence;
  overlapsWith: string[]; // keys of lower-ranked candidates absorbed by this habit
  /** ₹ added back per trade if the habit is fixed; used for the "without this habit" curve. */
  adjustments: Record<string, number>;
}

/** A pattern we checked and found not to be costing money (or too small / too uncertain). */
export interface Cleared {
  key: string;
  id: HabitId;
  title: string;
  detail: string; // e.g. "You re-entered within 15 min of a loss 2 times; those trades made +₹650."
  reason: 'profitable' | 'not-found' | 'too-small' | 'overlap' | 'not-significant';
}

/** A check that could not run because the file lacks the data. */
export interface Unavailable {
  id: HabitId;
  title: string;
  reason: string; // e.g. "Needs entry and exit times."
}

export interface Summary {
  from: string | null; // YYYY-MM-DD
  to: string | null;
  periodLabel: string; // e.g. "September 2026" or "1 Sep – 30 Sep 2026"
  trades: number;
  tradingDays: number;
  wins: number;
  losses: number;
  winRate: number; // 0..100
  grossPnl: number | null;
  fees: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number; // negative
  maxDrawdown: number; // positive ₹, closed-trade equity from zero
  bestDay: { date: string; netPnl: number } | null;
  worstDay: { date: string; netPnl: number } | null;
  longestLosingStreak: number;
}

export interface EquityPoint {
  tradeId: string;
  time: string | null;
  actual: number; // cumulative net P&L
  withoutHabits: number[]; // cumulative net if habits[0..i] were fixed (cumulative per rank)
}

export interface Review {
  summary: Summary;
  verdict: string; // one or two sentences, the headline of the review
  habits: Habit[]; // 0..3, ranked
  cleared: Cleared[];
  unavailable: Unavailable[];
  equity: EquityPoint[];
  notes: Note[]; // parse notes + analysis notes
  trades: Trade[]; // chronological
}

/** Saved in the browser when the user commits to fixing a habit. */
export interface Commitment {
  key: string;
  id: HabitId;
  title: string;
  rule: string;
  baselineCost: number;
  baselinePeriod: string;
  committedAt: string; // ISO
}

export interface CommitmentCheck {
  commitment: Commitment;
  status: 'improved' | 'same' | 'worse' | 'gone';
  currentCost: number; // ₹ this period for the same habit key (0 if not found)
  text: string; // one sentence for the UI
}
