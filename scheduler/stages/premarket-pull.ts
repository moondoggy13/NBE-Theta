import type { SupabaseClient } from "@supabase/supabase-js";
import { catalystProvider, macroProvider } from "../../src/server/services/registry";
import { logger } from "../lib/logger";

const CANDIDATE_UNIVERSE = ["NVDA", "AMZN", "META", "AAPL", "MSFT", "GOOGL", "TSLA", "AMD"];

const STOCK_META: Record<string, { name: string; sector: string; marketCap: number; avgVolume: number }> = {
  NVDA:  { name: "NVIDIA Corporation",   sector: "Technology",            marketCap: 3_200_000_000_000, avgVolume: 45_000_000 },
  AMZN:  { name: "Amazon.com Inc",       sector: "Consumer Discretionary", marketCap: 2_100_000_000_000, avgVolume: 38_000_000 },
  META:  { name: "Meta Platforms Inc",    sector: "Communication Services", marketCap: 1_500_000_000_000, avgVolume: 22_000_000 },
  AAPL:  { name: "Apple Inc",            sector: "Technology",            marketCap: 3_400_000_000_000, avgVolume: 55_000_000 },
  MSFT:  { name: "Microsoft Corporation", sector: "Technology",            marketCap: 3_100_000_000_000, avgVolume: 25_000_000 },
  GOOGL: { name: "Alphabet Inc",         sector: "Communication Services", marketCap: 2_200_000_000_000, avgVolume: 30_000_000 },
  TSLA:  { name: "Tesla Inc",            sector: "Consumer Discretionary", marketCap: 900_000_000_000,  avgVolume: 65_000_000 },
  AMD:   { name: "Advanced Micro Devices", sector: "Technology",            marketCap: 270_000_000_000,  avgVolume: 50_000_000 },
};

export async function runPremarketPull(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];

  // ── Fetch macro indicators from FRED (or mock) ──
  logger.info("  pulling macro indicators...");
  try {
    const indicators = await macroProvider.fetchIndicators();
    const snapshot = macroProvider.classifyRegime(indicators);

    for (const ind of indicators) {
      await db.from("macro_indicators").upsert(
        {
          series_id: ind.seriesId,
          label: ind.label,
          value: ind.value,
          previous: ind.previous,
          change_pct: ind.changePct,
          fetched_at: ind.fetchedAt,
          run_date: runDate,
        },
        { onConflict: "series_id,run_date" }
      );
    }

    logs.push(`Macro regime: ${snapshot.regime} (modifier ${snapshot.economicModifier > 0 ? "+" : ""}${snapshot.economicModifier})`);
    logs.push(`  ${snapshot.summary}`);
    logger.info(`  macro regime: ${snapshot.regime} — ${indicators.length} indicators cached`);

    await db.from("signal_events").insert({
      ticker: "MACRO",
      layer: "macro",
      message: snapshot.summary,
      impact: snapshot.regime === "risk_on" ? "bullish" : snapshot.regime === "risk_off" ? "bearish" : "neutral",
      run_date: runDate,
    });
  } catch (err) {
    logs.push(`Macro fetch error: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn("  macro fetch failed — continuing without macro data");
  }

  // ── Pull catalyst data per ticker ──
  for (const ticker of CANDIDATE_UNIVERSE) {
    const meta = STOCK_META[ticker] ?? { name: ticker, sector: "Unknown", marketCap: 0, avgVolume: 0 };
    logger.info(`  pulling catalyst data for ${ticker}...`);
    logs.push(`Pulling catalyst data for ${ticker}...`);

    const result = await catalystProvider.getLayer({
      ticker,
      name: meta.name,
      sector: meta.sector,
      marketCap: meta.marketCap,
      avgVolume: meta.avgVolume,
      currentPrice: 0,
      runDate,
    });

    await db.from("signal_scores").upsert(
      {
        run_date: runDate,
        ticker,
        name: meta.name,
        sector: meta.sector,
        market_cap: meta.marketCap,
        avg_volume: meta.avgVolume,
        catalyst_score: result.score,
        catalyst_signals: result.signals,
        catalyst_text: result.signals[0] ?? "",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "run_date,ticker" }
    );

    await db.from("signal_events").insert({
      ticker,
      layer: "catalyst",
      message: result.signals[0] ?? "Catalyst data pulled",
      impact: result.score > 18 ? "bullish" : result.score < 10 ? "bearish" : "neutral",
      run_date: runDate,
    });

    logs.push(`${ticker}: catalyst score ${result.score}/25`);
  }

  await db
    .from("pipeline_runs")
    .update({ logs })
    .eq("run_date", runDate)
    .eq("stage_id", "premarket_pull");
}
