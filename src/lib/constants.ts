export const STRATEGY = {
  MIN_CONVICTION_SCORE: 70,
  MAX_CONVICTION_SCORE: 100,
  LAYER_MAX_SCORE: 25,
  MAX_POSITIONS_PHASE1: 5,
  MAX_POSITIONS_PHASE3: 10,
  MAX_POSITION_SIZE_PCT: 2,
  DAILY_LOSS_KILL_SWITCH_PCT: -3,
  STOP_LOSS_MIN_PCT: 5,
  STOP_LOSS_MAX_PCT: 8,
  MIN_AVG_VOLUME: 2_000_000,
  MIN_MARKET_CAP: 500_000_000,
  MIN_IVR: 50,
  MIN_SHARE_PRICE: 5,
} as const;

export const PIPELINE_SCHEDULE = [
  { id: "premarket_pull", label: "Pre-Market Data Pull", time: "06:00", hour: 6, minute: 0 },
  { id: "claude_analysis", label: "Claude Analysis", time: "06:15", hour: 6, minute: 15 },
  { id: "signal_crossref", label: "Signal Cross-Reference", time: "06:30", hour: 6, minute: 30 },
  { id: "universe_finalization", label: "Universe Finalization", time: "06:45", hour: 6, minute: 45 },
  { id: "execution", label: "Market Open — Execution", time: "09:30", hour: 9, minute: 30 },
  { id: "regime_check", label: "Mid-Day Regime Check", time: "12:00", hour: 12, minute: 0 },
  { id: "eod_review", label: "End-of-Day Review", time: "16:00", hour: 16, minute: 0 },
] as const;

export const SIGNAL_LAYERS = [
  { name: "catalyst", label: "Catalyst", color: "var(--signal-catalyst)", dataSource: "Perplexity Finance" },
  { name: "technical", label: "Technical", color: "var(--signal-technical)", dataSource: "Alpaca Market Data" },
  { name: "options_flow", label: "Options Flow", color: "var(--signal-options)", dataSource: "Unusual Whales" },
  { name: "sentiment", label: "Sentiment", color: "var(--signal-sentiment)", dataSource: "Supabase pgvector / News" },
  { name: "economic", label: "Economic", color: "var(--signal-economic)", dataSource: "Economic Calendar" },
] as const;

export const FRED_SERIES_IDS = [
  "FEDFUNDS", "T10Y2Y", "VIXCLS", "CPIAUCSL",
  "UNRATE", "MORTGAGE30US", "UMCSENT", "DGS10",
] as const;

export const MARKET_HOURS = {
  preMarketOpen: { hour: 4, minute: 0 },
  marketOpen: { hour: 9, minute: 30 },
  marketClose: { hour: 16, minute: 0 },
  afterHoursClose: { hour: 20, minute: 0 },
} as const;
