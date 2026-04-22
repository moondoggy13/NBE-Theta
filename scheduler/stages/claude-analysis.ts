import type { SupabaseClient } from "@supabase/supabase-js";
import { ClaudeAnalysisService } from "../../src/server/services/claude/analysis-service";
import { premarketPrompt, formatMacroContext } from "../../src/server/services/claude/prompts";
import { macroProvider } from "../../src/server/services/registry";
import { logger } from "../lib/logger";

interface PremarketResult {
  stocks: Array<{ ticker: string; score: number; thesis: string; risk: string }>;
  correlationRisks: string;
  sectorNotes: string;
}

export async function runClaudeAnalysis(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];
  logs.push("Starting Claude pre-market analysis...");

  const claude = new ClaudeAnalysisService(db);

  const { data: rows } = await db
    .from("signal_scores")
    .select("ticker, name, sector, catalyst_signals, catalyst_score")
    .eq("run_date", runDate);

  if (!rows?.length) {
    logs.push("No signal scores found — skipping Claude analysis");
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "claude_analysis");
    return;
  }

  if (!claude.isAvailable) {
    logs.push("No ANTHROPIC_API_KEY — using catalyst scores as-is");
    for (const row of rows) {
      logs.push(`${row.ticker}: catalyst ${row.catalyst_score}/25 (unrefined)`);
    }
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "claude_analysis");
    return;
  }

  // Load macro regime for context
  let macroContext = "Macro data: unavailable";
  try {
    const { data: macroRows } = await db
      .from("macro_indicators")
      .select("*")
      .eq("run_date", runDate);

    if (macroRows?.length) {
      const indicators = macroRows.map((r) => ({
        seriesId: r.series_id as string,
        label: r.label as string,
        value: Number(r.value),
        previous: r.previous != null ? Number(r.previous) : null,
        changePct: r.change_pct != null ? Number(r.change_pct) : null,
        fetchedAt: r.fetched_at as string,
      }));
      const snapshot = macroProvider.classifyRegime(indicators);
      macroContext = formatMacroContext(snapshot);
    }
  } catch {
    // Continue without macro context
  }

  // Build batch prompt for all stocks
  const stocks = rows.map((row) => ({
    ticker: row.ticker,
    name: row.name ?? row.ticker,
    sector: row.sector ?? "Unknown",
    catalystScore: row.catalyst_score,
    catalystSignals: row.catalyst_signals ?? [],
  }));

  const prompt = premarketPrompt(stocks, macroContext);
  logger.info("  sending batch analysis to Claude...");

  const { data: result } = await claude.analyze<PremarketResult>({
    prompt,
    stage: "premarket",
    runDate,
    maxTokens: 1500,
  });

  if (result?.stocks?.length) {
    for (const assessment of result.stocks) {
      const original = rows.find((r) => r.ticker === assessment.ticker);
      if (!original) continue;

      const score = Math.min(25, Math.max(0, Number(assessment.score) || original.catalyst_score));

      await db.from("signal_scores").update({
        catalyst_score: score,
        catalyst_text: assessment.thesis || original.catalyst_signals?.[0] || "",
        claude_thesis: assessment.thesis,
        updated_at: new Date().toISOString(),
      }).eq("run_date", runDate).eq("ticker", assessment.ticker);

      logs.push(`${assessment.ticker}: Claude refined catalyst to ${score}/25 — ${assessment.thesis}`);
      logger.info(`  ${assessment.ticker}: ${score}/25`);
    }

    if (result.correlationRisks) {
      logs.push(`Correlation risks: ${result.correlationRisks}`);
    }
    if (result.sectorNotes) {
      logs.push(`Sector notes: ${result.sectorNotes}`);
    }
  } else {
    logs.push("Claude returned no parseable result — keeping original scores");
    for (const row of rows) {
      logs.push(`${row.ticker}: catalyst ${row.catalyst_score}/25 (unrefined)`);
    }
  }

  logs.push("Claude pre-market analysis complete");
  await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "claude_analysis");
}
