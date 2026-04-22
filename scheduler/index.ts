import { config } from "dotenv";
config({ path: [".env.local", ".env"], override: true });
import { getDb } from "./lib/supabase";
import { logger } from "./lib/logger";
import { getETMinuteOfDay, formatETDate, isWeekend, msUntilNextTradingDay } from "./lib/market-hours";
import { runPremarketPull } from "./stages/premarket-pull";
import { runClaudeAnalysis } from "./stages/claude-analysis";
import { runSignalCrossref } from "./stages/signal-crossref";
import { runUniverseFinalization } from "./stages/universe-finalization";
import { runExecution } from "./stages/execution";
import { runRegimeCheck } from "./stages/regime-check";
import { runEodReview } from "./stages/eod-review";
import type { SupabaseClient } from "@supabase/supabase-js";

// Pipeline schedule in minutes-since-midnight (ET)
const STAGES = [
  { id: "premarket_pull", time: 360, label: "Pre-Market Data Pull", handler: runPremarketPull },
  { id: "claude_analysis", time: 375, label: "Claude Analysis", handler: runClaudeAnalysis },
  { id: "signal_crossref", time: 390, label: "Signal Cross-Reference", handler: runSignalCrossref },
  { id: "universe_finalization", time: 405, label: "Universe Finalization", handler: runUniverseFinalization },
  { id: "execution", time: 570, label: "Market Open — Execution", handler: runExecution },
  { id: "regime_check", time: 720, label: "Mid-Day Regime Check", handler: runRegimeCheck },
  { id: "eod_review", time: 960, label: "End-of-Day Review", handler: runEodReview },
] as const;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStage(
  db: SupabaseClient,
  stageId: string,
  label: string,
  handler: (db: SupabaseClient, runDate: string) => Promise<void>,
  runDate: string
) {
  logger.info(`starting stage: ${label}`);

  await db.from("pipeline_runs").upsert(
    {
      run_date: runDate,
      stage_id: stageId,
      status: "active",
      started_at: new Date().toISOString(),
      logs: [],
    },
    { onConflict: "run_date,stage_id" }
  );

  try {
    await handler(db, runDate);
    await db
      .from("pipeline_runs")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("run_date", runDate)
      .eq("stage_id", stageId);
    logger.info(`completed: ${label}`);
  } catch (err) {
    logger.error(`error in ${label}:`, err);
    await db
      .from("pipeline_runs")
      .update({
        status: "error",
        completed_at: new Date().toISOString(),
        error_message: err instanceof Error ? err.message : String(err),
      })
      .eq("run_date", runDate)
      .eq("stage_id", stageId);
  }
}

async function getCompletedStages(db: SupabaseClient, runDate: string): Promise<Set<string>> {
  const { data } = await db
    .from("pipeline_runs")
    .select("stage_id")
    .eq("run_date", runDate)
    .eq("status", "completed");
  return new Set((data ?? []).map((r) => r.stage_id));
}

async function scheduleLoop() {
  const db = getDb();
  logger.info("NB&E Triangle Scheduler started");
  logger.info(`Supabase: ${process.env.SUPABASE_URL ? "configured" : "MISSING"}`);

  while (true) {
    // Weekend check
    if (isWeekend()) {
      const ms = msUntilNextTradingDay();
      logger.info(`weekend — sleeping ${Math.round(ms / 60_000)}m until next trading day`);
      await sleep(ms);
      continue;
    }

    const runDate = formatETDate();
    const now = getETMinuteOfDay();
    const completed = await getCompletedStages(db, runDate);

    // Find next pending stage
    let nextStage = null;
    for (const stage of STAGES) {
      if (!completed.has(stage.id)) {
        nextStage = stage;
        break;
      }
    }

    if (!nextStage) {
      // All stages done for today
      const ms = msUntilNextTradingDay();
      logger.info(`all stages complete for ${runDate} — sleeping until next trading day`);
      await sleep(ms);
      continue;
    }

    if (now >= nextStage.time) {
      // Time to run this stage
      await runStage(db, nextStage.id, nextStage.label, nextStage.handler, runDate);
      // Brief pause before checking next
      await sleep(2_000);
    } else {
      // Wait until the stage's scheduled time
      const msToWait = (nextStage.time - now) * 60_000;
      logger.info(`next: ${nextStage.label} in ${Math.round(msToWait / 60_000)}m`);
      // Wake up every 60s to recheck (in case of clock drift or manual restart)
      await sleep(Math.min(msToWait, 60_000));
    }
  }
}

scheduleLoop().catch((err) => {
  logger.error("fatal scheduler error:", err);
  process.exit(1);
});
