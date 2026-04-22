import type { IMacroProvider, MacroIndicator, MacroSnapshot } from "./types";
import { FRED_SERIES } from "./types";
import { classifyRegimeFromIndicators } from "./classify";

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

/**
 * Fetches macro economic indicators from the FRED API.
 * Requires FRED_API_KEY environment variable.
 *
 * FRED API docs: https://fred.stlouisfed.org/docs/api/fred/
 * Rate limit: 120 requests per minute (free tier).
 */
export class FredMacroProvider implements IMacroProvider {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.FRED_API_KEY || "";
  }

  async fetchIndicators(): Promise<MacroIndicator[]> {
    const results: MacroIndicator[] = [];

    // Fetch all series in parallel
    const fetches = FRED_SERIES.map(async (series) => {
      try {
        const url = new URL(FRED_BASE);
        url.searchParams.set("series_id", series.id);
        url.searchParams.set("api_key", this.apiKey);
        url.searchParams.set("file_type", "json");
        url.searchParams.set("sort_order", "desc");
        url.searchParams.set("limit", "2"); // latest + previous for change calc

        const res = await fetch(url.toString(), {
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
          console.warn(`FRED ${series.id}: HTTP ${res.status}`);
          return null;
        }

        const data = await res.json();
        const observations = (data.observations ?? []).filter(
          (o: { value: string }) => o.value !== "."
        );

        if (observations.length === 0) return null;

        const latest = parseFloat(observations[0].value);
        const previous = observations.length > 1 ? parseFloat(observations[1].value) : null;
        const changePct =
          previous !== null && previous !== 0
            ? Math.round(((latest - previous) / Math.abs(previous)) * 10000) / 100
            : null;

        return {
          seriesId: series.id,
          label: series.label,
          value: latest,
          previous,
          changePct,
          fetchedAt: new Date().toISOString(),
        } satisfies MacroIndicator;
      } catch (err) {
        console.warn(`FRED ${series.id}: fetch error`, err);
        return null;
      }
    });

    const settled = await Promise.all(fetches);
    for (const result of settled) {
      if (result) results.push(result);
    }

    return results;
  }

  classifyRegime(indicators: MacroIndicator[]): MacroSnapshot {
    return classifyRegimeFromIndicators(indicators);
  }
}
