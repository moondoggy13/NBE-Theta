export interface MacroIndicator {
  seriesId: string;
  label: string;
  value: number;
  previous: number | null;
  changePct: number | null;
  fetchedAt: string;
}

export type MacroRegime = "risk_on" | "neutral" | "risk_off";

export interface MacroSnapshot {
  regime: MacroRegime;
  indicators: MacroIndicator[];
  /** Score modifier applied to economic layer: -3 to +3 */
  economicModifier: number;
  summary: string;
  fetchedAt: string;
}

export interface IMacroProvider {
  /** Fetch latest values for all tracked FRED series */
  fetchIndicators(): Promise<MacroIndicator[]>;
  /** Classify the current macro regime from indicator values */
  classifyRegime(indicators: MacroIndicator[]): MacroSnapshot;
}

/** FRED series we track for macro regime classification */
export const FRED_SERIES = [
  { id: "FEDFUNDS", label: "Fed Funds Rate" },
  { id: "T10Y2Y", label: "10Y-2Y Treasury Spread" },
  { id: "VIXCLS", label: "VIX" },
  { id: "CPIAUCSL", label: "CPI" },
  { id: "UNRATE", label: "Unemployment Rate" },
  { id: "MORTGAGE30US", label: "30-Year Mortgage Rate" },
  { id: "UMCSENT", label: "Consumer Sentiment" },
  { id: "DGS10", label: "10-Year Treasury Yield" },
] as const;
