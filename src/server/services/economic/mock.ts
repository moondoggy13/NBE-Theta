import type { IEconomicProvider, EconomicEvent, ProviderInput, LayerResult } from "../types";

export class MockEconomicProvider implements IEconomicProvider {
  async getTodayEvents(): Promise<EconomicEvent[]> {
    return [
      { time: "08:30", currency: "USD", event: "Initial Jobless Claims", impact: "medium", forecast: "215K", previous: "219K" },
      { time: "10:00", currency: "USD", event: "ISM Manufacturing PMI", impact: "high", forecast: "49.5", previous: "48.4" },
      { time: "14:00", currency: "USD", event: "FOMC Minutes", impact: "high" },
    ];
  }

  async getLayer(input: ProviderInput, events: EconomicEvent[]): Promise<LayerResult> {
    const highImpact = events.filter((e) => e.impact === "high").length;
    const macroSensitive = ["Financials", "Energy", "Materials", "Real Estate"].includes(input.sector);

    // High-impact events create uncertainty: penalize slightly unless sector benefits
    let score = 15;
    if (highImpact === 0) score += 5; // calm macro day = bullish
    if (highImpact >= 2) score -= 3;  // volatile macro day = cautious
    if (macroSensitive && highImpact > 0) score -= 2;

    score = Math.max(0, Math.min(25, score));

    return {
      score,
      signals: events.map((e) => `${e.time} ET: ${e.event} (${e.impact} impact)`),
      dataSource: "Economic Calendar (Mock)",
      updatedAt: new Date().toISOString(),
    };
  }
}
