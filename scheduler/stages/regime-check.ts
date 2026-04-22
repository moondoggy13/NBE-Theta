import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAvailable as alpacaAvailable,
  getLatestPrice,
} from "../../src/server/services/alpaca/client";
import { ClaudeAnalysisService } from "../../src/server/services/claude/analysis-service";
import { regimePrompt, formatMacroContext } from "../../src/server/services/claude/prompts";
import { macroProvider } from "../../src/server/services/registry";
import { logger } from "../lib/logger";

const KILL_SWITCH_PCT = -3;

interface RegimeResult {
  marketCharacter: "trending" | "choppy" | "reversing";
  overallAction: "hold" | "reduce" | "exit_all";
  positions: Array<{ ticker: string; action: string; reason: string }>;
  summary: string;
}

export async function runRegimeCheck(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];
  logs.push("Mid-day regime check starting...");

  const { data: positions } = await db.from("positions").select("*").eq("status", "active");
  const { data: portfolioRow } = await db
    .from("portfolio_state")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (!positions?.length) {
    logs.push("No active positions — regime check skipped");
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "regime_check");
    return;
  }

  // ── Sync live prices from Alpaca ──
  if (alpacaAvailable()) {
    for (const pos of positions) {
      try {
        const livePrice = await getLatestPrice(pos.ticker);
        const pnlDollars = (livePrice - Number(pos.entry_price)) * Number(pos.shares);
        const pnlPercent = ((livePrice - Number(pos.entry_price)) / Number(pos.entry_price)) * 100;

        await db.from("positions").update({
          current_price: livePrice,
          pnl_dollars: pnlDollars,
          pnl_percent: pnlPercent,
        }).eq("ticker", pos.ticker);

        pos.current_price = livePrice;
        pos.pnl_dollars = pnlDollars;
        pos.pnl_percent = pnlPercent;
      } catch {
        logs.push(`${pos.ticker}: live price sync failed, using last known`);
      }
    }
    logs.push(`Synced live prices for ${positions.length} positions`);
  }

  const totalValue = portfolioRow ? Number(portfolioRow.total_value) : 10_000;
  const dailyPnl = positions.reduce((sum, p) => sum + Number(p.pnl_dollars), 0);
  const dailyPnlPct = totalValue > 0 ? (dailyPnl / totalValue) * 100 : 0;

  logs.push(`Daily P&L: $${dailyPnl.toFixed(2)} (${dailyPnlPct.toFixed(2)}%)`);

  // Check kill switch
  if (dailyPnlPct <= KILL_SWITCH_PCT) {
    logger.warn("KILL SWITCH TRIGGERED — halting all activity");
    logs.push(`KILL SWITCH TRIGGERED: P&L ${dailyPnlPct.toFixed(2)}% <= ${KILL_SWITCH_PCT}%`);

    // Mark all positions as exiting
    await db.from("positions").update({ status: "exiting" }).eq("status", "active");

    // Update portfolio state with kill switch
    await db.from("portfolio_state").insert({
      total_value: totalValue,
      cash_available: portfolioRow ? Number(portfolioRow.cash_available) : 0,
      day_pnl_dollars: dailyPnl,
      day_pnl_percent: dailyPnlPct,
      total_pnl_dollars: portfolioRow ? Number(portfolioRow.total_pnl_dollars) + dailyPnl : dailyPnl,
      total_pnl_percent: portfolioRow ? Number(portfolioRow.total_pnl_percent) + dailyPnlPct : dailyPnlPct,
      position_count: positions.length,
      max_positions: 5,
      kill_switch_active: true,
    });
  } else {
    logs.push(`Kill switch clear: ${(dailyPnlPct - KILL_SWITCH_PCT).toFixed(2)}% from threshold`);

    // Write PnL snapshot
    await db.from("pnl_snapshots").insert({
      captured_at: new Date().toISOString(),
      pnl_dollars: dailyPnl,
      run_date: runDate,
    });

    // Update portfolio state
    await db.from("portfolio_state").insert({
      total_value: totalValue + dailyPnl,
      cash_available: portfolioRow ? Number(portfolioRow.cash_available) : 0,
      day_pnl_dollars: dailyPnl,
      day_pnl_percent: dailyPnlPct,
      total_pnl_dollars: portfolioRow ? Number(portfolioRow.total_pnl_dollars) + dailyPnl : dailyPnl,
      total_pnl_percent: ((totalValue + dailyPnl - 10_000) / 10_000) * 100,
      position_count: positions.length,
      max_positions: 5,
    });
  }

  for (const p of positions) {
    logs.push(`  ${p.ticker}: $${Number(p.pnl_dollars).toFixed(2)} (${Number(p.pnl_percent).toFixed(2)}%)`);
  }

  // ── Claude Regime Assessment ──
  const claude = new ClaudeAnalysisService(db);
  if (claude.isAvailable && positions.length > 0) {
    try {
      // Load macro context
      let macroCtx = "Macro data: unavailable";
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
        macroCtx = formatMacroContext(macroProvider.classifyRegime(indicators));
      }

      const positionData = positions.map((p) => ({
        ticker: p.ticker as string,
        entryPrice: Number(p.entry_price),
        currentPrice: Number(p.current_price),
        pnlPercent: Number(p.pnl_percent),
        stopLoss: Number(p.stop_loss),
        target: Number(p.target),
      }));

      const prompt = regimePrompt(positionData, dailyPnlPct, macroCtx);
      const { data: regime } = await claude.analyze<RegimeResult>({
        prompt,
        stage: "regime",
        runDate,
        maxTokens: 768,
      });

      if (regime) {
        logs.push(`Claude regime: ${regime.marketCharacter} market, action=${regime.overallAction}`);
        logs.push(`  Summary: ${regime.summary}`);

        for (const rec of regime.positions ?? []) {
          logs.push(`  ${rec.ticker}: ${rec.action} — ${rec.reason}`);

          await db.from("signal_events").insert({
            ticker: rec.ticker,
            layer: "claude",
            message: `Regime: ${rec.action} — ${rec.reason}`,
            impact: rec.action === "exit_early" ? "bearish" : rec.action === "tighten_stop" ? "neutral" : "bullish",
            run_date: runDate,
          });
        }
      }
    } catch (err) {
      logs.push(`Claude regime assessment error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "regime_check");
}
