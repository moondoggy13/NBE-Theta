import type { IMacroProvider, MacroIndicator, MacroSnapshot } from "./types";
import { classifyRegimeFromIndicators } from "./classify";

/**
 * Mock macro provider with realistic baseline values.
 * Used when FRED_API_KEY is not set.
 */
export class MockMacroProvider implements IMacroProvider {
  async fetchIndicators(): Promise<MacroIndicator[]> {
    const now = new Date().toISOString();
    return [
      { seriesId: "FEDFUNDS", label: "Fed Funds Rate", value: 4.33, previous: 4.33, changePct: 0, fetchedAt: now },
      { seriesId: "T10Y2Y", label: "10Y-2Y Treasury Spread", value: 0.21, previous: 0.18, changePct: 16.67, fetchedAt: now },
      { seriesId: "VIXCLS", label: "VIX", value: 16.8, previous: 17.2, changePct: -2.33, fetchedAt: now },
      { seriesId: "CPIAUCSL", label: "CPI", value: 314.69, previous: 313.53, changePct: 0.37, fetchedAt: now },
      { seriesId: "UNRATE", label: "Unemployment Rate", value: 4.0, previous: 4.1, changePct: -2.44, fetchedAt: now },
      { seriesId: "MORTGAGE30US", label: "30-Year Mortgage Rate", value: 6.67, previous: 6.73, changePct: -0.89, fetchedAt: now },
      { seriesId: "UMCSENT", label: "Consumer Sentiment", value: 67.4, previous: 66.4, changePct: 1.51, fetchedAt: now },
      { seriesId: "DGS10", label: "10-Year Treasury Yield", value: 4.25, previous: 4.30, changePct: -1.16, fetchedAt: now },
    ];
  }

  classifyRegime(indicators: MacroIndicator[]): MacroSnapshot {
    return classifyRegimeFromIndicators(indicators);
  }
}
