import type { SupabaseClient } from "@supabase/supabase-js";
import {
  technicalProvider,
  optionsProvider,
  sentimentProvider,
  economicProvider,
  macroProvider,
} from "../../src/server/services/registry";
import type { MacroSnapshot } from "../../src/server/services/macro/types";
import { ClaudeAnalysisService } from "../../src/server/services/claude/analysis-service";
import { synthesisPrompt, formatMacroContext } from "../../src/server/services/claude/prompts";
import { logger } from "../lib/logger";

interface SynthesisResult {
  confirming: boolean;
  confidence: "high" | "medium" | "low";
  modifier: number;
  risk: string;
  thesis: string;
}

export async function runSignalCrossref(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];

  // Fetch economic events once for the whole run
  const economicEvents = await economicProvider.getTodayEvents();
  logs.push(`Economic events today: ${economicEvents.length} (${economicEvents.filter((e) => e.impact === "high").length} high-impact)`);

  // Load macro regime from today's cached indicators
  let macroSnapshot: MacroSnapshot | null = null;
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
      macroSnapshot = macroProvider.classifyRegime(indicators);
      logs.push(`Macro regime: ${macroSnapshot.regime} (economic modifier: ${macroSnapshot.economicModifier > 0 ? "+" : ""}${macroSnapshot.economicModifier})`);
    } else {
      logs.push("No macro indicators cached — skipping regime modifier");
    }
  } catch {
    logs.push("Macro regime lookup failed — continuing without modifier");
  }

  const { data: rows } = await db
    .from("signal_scores")
    .select("*")
    .eq("run_date", runDate);

  if (!rows?.length) {
    logs.push("No signal scores found — skipping cross-reference");
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "signal_crossref");
    return;
  }

  for (const row of rows) {
    const input = {
      ticker: row.ticker,
      name: row.name,
      sector: row.sector ?? "Unknown",
      marketCap: Number(row.market_cap ?? 0),
      avgVolume: Number(row.avg_volume ?? 0),
      currentPrice: Number(row.current_price ?? 0),
      runDate,
    };

    logger.info(`  cross-referencing ${row.ticker}...`);

    const [technical, options, sentiment, economic] = await Promise.all([
      technicalProvider.getLayer(input),
      optionsProvider.getLayer(input),
      sentimentProvider.getLayer(input),
      economicProvider.getLayer(input, economicEvents),
    ]);

    // Apply macro regime modifier to economic score (clamped 0-25)
    const adjustedEconomic = Math.max(0, Math.min(25,
      economic.score + (macroSnapshot?.economicModifier ?? 0)
    ));

    // Raw sum: 5 layers × 0-25 = 0-125, normalize to 0-100
    const rawSum =
      row.catalyst_score + technical.score + options.score + sentiment.score + adjustedEconomic;
    const convictionScore = Math.round((rawSum / 125) * 100);

    await db.from("signal_scores").update({
      technical_score: technical.score,
      technical_signals: technical.signals,
      options_score: options.score,
      options_signals: options.signals,
      sentiment_score: sentiment.score,
      sentiment_signals: sentiment.signals,
      economic_score: adjustedEconomic,
      economic_signals: economic.signals,
      conviction_score: convictionScore,
      updated_at: new Date().toISOString(),
    }).eq("run_date", runDate).eq("ticker", row.ticker);

    // Emit signal events for notable scores
    for (const layer of [
      { name: "technical", result: technical },
      { name: "options_flow", result: options },
      { name: "sentiment", result: sentiment },
      { name: "economic", result: economic },
    ]) {
      if (layer.result.score >= 18) {
        await db.from("signal_events").insert({
          ticker: row.ticker,
          layer: layer.name,
          message: layer.result.signals[0] ?? `${layer.name} score ${layer.result.score}/25`,
          impact: "bullish",
          run_date: runDate,
        });
      }
    }

    logs.push(
      `${row.ticker}: CAT=${row.catalyst_score} TECH=${technical.score} OPT=${options.score} SENT=${sentiment.score} ECON=${adjustedEconomic}${macroSnapshot ? ` (raw ${economic.score}${macroSnapshot.economicModifier >= 0 ? "+" : ""}${macroSnapshot.economicModifier})` : ""} → conviction=${convictionScore}`
    );
  }

  // ── Claude Signal Synthesis Pass ──
  // For stocks with conviction >= 60, ask Claude to validate signal alignment
  const claude = new ClaudeAnalysisService(db);
  if (claude.isAvailable) {
    const { data: candidates } = await db
      .from("signal_scores")
      .select("*")
      .eq("run_date", runDate)
      .gte("conviction_score", 60);

    if (candidates?.length) {
      const macroCtx = macroSnapshot ? formatMacroContext(macroSnapshot) : "Macro data: unavailable";
      logs.push(`Claude synthesis: analyzing ${candidates.length} candidates with conviction >= 60`);

      for (const c of candidates) {
        const prompt = synthesisPrompt(
          c.ticker,
          c.name,
          {
            catalyst: { score: c.catalyst_score, signals: c.catalyst_signals ?? [] },
            technical: { score: c.technical_score, signals: c.technical_signals ?? [] },
            options: { score: c.options_score, signals: c.options_signals ?? [] },
            sentiment: { score: c.sentiment_score, signals: c.sentiment_signals ?? [] },
            economic: { score: c.economic_score, signals: c.economic_signals ?? [] },
          },
          c.conviction_score,
          macroCtx
        );

        const { data: synthesis } = await claude.analyze<SynthesisResult>({
          prompt,
          stage: "synthesis",
          ticker: c.ticker,
          runDate,
          maxTokens: 512,
        });

        if (synthesis) {
          const modifier = Math.max(-5, Math.min(5, synthesis.modifier || 0));
          const adjustedConviction = Math.max(0, Math.min(100, c.conviction_score + modifier));

          await db.from("signal_scores").update({
            claude_confidence: modifier,
            claude_thesis: synthesis.thesis,
            conviction_score: adjustedConviction,
            updated_at: new Date().toISOString(),
          }).eq("run_date", runDate).eq("ticker", c.ticker);

          logs.push(`  ${c.ticker}: Claude ${synthesis.confidence} confidence, modifier ${modifier > 0 ? "+" : ""}${modifier} → conviction=${adjustedConviction}`);

          if (modifier !== 0) {
            await db.from("signal_events").insert({
              ticker: c.ticker,
              layer: "claude",
              message: `Claude ${synthesis.confidence}: ${synthesis.thesis} (risk: ${synthesis.risk})`,
              impact: modifier > 0 ? "bullish" : modifier < 0 ? "bearish" : "neutral",
              run_date: runDate,
            });
          }
        }
      }
    }
  } else {
    logs.push("Claude synthesis: skipped (no ANTHROPIC_API_KEY)");
  }

  await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "signal_crossref");
}
