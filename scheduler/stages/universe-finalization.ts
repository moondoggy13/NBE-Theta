import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger";

const MIN_CONVICTION = 70;
const MAX_POSITIONS = 5;

export async function runUniverseFinalization(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];

  // Reset all in_universe flags for today
  await db
    .from("signal_scores")
    .update({ in_universe: false })
    .eq("run_date", runDate);

  // Select top candidates above threshold
  const { data: candidates } = await db
    .from("signal_scores")
    .select("ticker, conviction_score")
    .eq("run_date", runDate)
    .gte("conviction_score", MIN_CONVICTION)
    .order("conviction_score", { ascending: false })
    .limit(MAX_POSITIONS);

  if (!candidates?.length) {
    logs.push(`No stocks above conviction threshold (${MIN_CONVICTION})`);
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "universe_finalization");
    return;
  }

  // Mark selected stocks as in universe
  const tickers = candidates.map((c) => c.ticker);
  await db
    .from("signal_scores")
    .update({ in_universe: true })
    .eq("run_date", runDate)
    .in("ticker", tickers);

  for (const c of candidates) {
    logs.push(`✓ ${c.ticker} — conviction ${c.conviction_score}/100`);
    logger.info(`  universe: ${c.ticker} (${c.conviction_score})`);
  }

  logs.push(`Universe finalized: ${candidates.length} stocks selected`);
  await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "universe_finalization");
}
