import type { IEconomicProvider, EconomicEvent, ProviderInput, LayerResult } from "../types";

/**
 * Fetches economic calendar data from a public JSON endpoint.
 * Uses neko-api.com (free, no auth required) as the data source.
 * Falls back to empty events on failure.
 */
export class ForexFactoryProvider implements IEconomicProvider {
  async getTodayEvents(): Promise<EconomicEvent[]> {
    try {
      // Use a free economic calendar API
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(
        `https://nfs.faireconomy.media/ff_calendar_thisweek.json`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!res.ok) return [];

      const data = await res.json();

      // Filter to today's USD events and map to our format
      return (data as Array<Record<string, string>>)
        .filter((e) => e.date?.startsWith(today) && e.country === "USD")
        .map((e) => ({
          time: e.date ? new Date(e.date).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" }) : "00:00",
          currency: "USD",
          event: e.title || "Unknown Event",
          impact: (e.impact === "High" ? "high" : e.impact === "Medium" ? "medium" : "low") as EconomicEvent["impact"],
          forecast: e.forecast || undefined,
          previous: e.previous || undefined,
          actual: e.actual || undefined,
        }));
    } catch {
      return [];
    }
  }

  async getLayer(input: ProviderInput, events: EconomicEvent[]): Promise<LayerResult> {
    const highImpact = events.filter((e) => e.impact === "high").length;
    const medImpact = events.filter((e) => e.impact === "medium").length;
    const macroSensitive = ["Financials", "Energy", "Materials", "Real Estate", "Utilities"].includes(input.sector);

    let score = 15;

    // Positive actual vs forecast = bullish macro
    const beats = events.filter(
      (e) => e.actual && e.forecast && parseFloat(e.actual) > parseFloat(e.forecast)
    ).length;
    const misses = events.filter(
      (e) => e.actual && e.forecast && parseFloat(e.actual) < parseFloat(e.forecast)
    ).length;

    score += beats * 2;
    score -= misses * 2;

    // High-impact uncertainty
    if (highImpact === 0 && medImpact <= 1) score += 4; // calm day
    if (highImpact >= 2) score -= 3;

    // Sector sensitivity
    if (macroSensitive && highImpact > 0) score -= 2;

    score = Math.max(0, Math.min(25, score));

    const signals = events.length > 0
      ? events.slice(0, 4).map((e) => {
          let suffix = "";
          if (e.actual) suffix = ` | Actual: ${e.actual}`;
          else if (e.forecast) suffix = ` | Forecast: ${e.forecast}`;
          return `${e.time} ET: ${e.event} (${e.impact})${suffix}`;
        })
      : ["No USD economic events today"];

    return {
      score,
      signals,
      dataSource: "Economic Calendar",
      updatedAt: new Date().toISOString(),
    };
  }
}
