import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAvailable as alpacaAvailable,
  closeAllPositions,
  getAccount,
  getLatestPrice,
} from "../../src/server/services/alpaca/client";
import { ClaudeAnalysisService } from "../../src/server/services/claude/analysis-service";
import { eodReflectionPrompt, formatMacroContext } from "../../src/server/services/claude/prompts";
import { macroProvider } from "../../src/server/services/registry";
import { logger } from "../lib/logger";

interface EodResult {
  winRate: number;
  bestSignalLayer: string;
  worstSignalLayer: string;
  highConvictionAccuracy: number;
  learnings: string[];
  tomorrowAdjustments: string;
}

export async function runEodReview(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];
  const useAlpaca = alpacaAvailable();
  logs.push(`End-of-day review — ${useAlpaca ? "LIVE Alpaca paper trading" : "database-only mode"}`);

  const { data: positions } = await db.from("positions").select("*");

  if (!positions?.length) {
    logs.push("No positions to close");
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "eod_review");
    return;
  }

  // ── Update positions with live prices before closing ──
  if (useAlpaca) {
    for (const pos of positions) {
      try {
        const livePrice = await getLatestPrice(pos.ticker);
        const pnlDollars = (livePrice - Number(pos.entry_price)) * Number(pos.shares);
        const pnlPercent = ((livePrice - Number(pos.entry_price)) / Number(pos.entry_price)) * 100;

        pos.current_price = livePrice;
        pos.pnl_dollars = pnlDollars;
        pos.pnl_percent = pnlPercent;
      } catch {
        logs.push(`${pos.ticker}: price fetch failed, using last known price`);
      }
    }
  }

  let totalDayPnl = 0;

  // ── Close all positions — record as trades ──
  for (const pos of positions) {
    const pnlDollars = Number(pos.pnl_dollars);
    const pnlPercent = Number(pos.pnl_percent);
    const enteredAt = new Date(pos.entered_at);
    const exitedAt = new Date();
    const holdTimeMinutes = Math.round((exitedAt.getTime() - enteredAt.getTime()) / 60_000);

    await db.from("trades").insert({
      ticker: pos.ticker,
      side: "long",
      entry_price: pos.entry_price,
      exit_price: pos.current_price,
      shares: pos.shares,
      pnl_dollars: pnlDollars,
      pnl_percent: pnlPercent,
      entered_at: pos.entered_at,
      exited_at: exitedAt.toISOString(),
      hold_time_minutes: holdTimeMinutes,
      conviction_at_entry: pos.conviction_at_entry,
      exit_reason: "eod",
    });

    totalDayPnl += pnlDollars;
    logs.push(`CLOSED ${pos.ticker}: ${Number(pos.shares)} shares | P&L $${pnlDollars.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
    logger.info(`  closed: ${pos.ticker} P&L $${pnlDollars.toFixed(2)}`);
  }

  // ── Close positions on Alpaca ──
  if (useAlpaca) {
    try {
      const closed = await closeAllPositions();
      logs.push(`Alpaca: ${closed.length} position(s) close order(s) submitted`);
    } catch (err) {
      logs.push(`Alpaca close error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Delete all positions from Supabase (recorded as trades) ──
  await db.from("positions").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  // ── PnL snapshot ──
  await db.from("pnl_snapshots").insert({
    captured_at: new Date().toISOString(),
    pnl_dollars: totalDayPnl,
    run_date: runDate,
  });

  // ── Portfolio state — sync from Alpaca if available ──
  let finalValue: number;
  let finalCash: number;

  if (useAlpaca) {
    try {
      const account = await getAccount();
      finalValue = parseFloat(account.portfolio_value);
      finalCash = parseFloat(account.cash);
      logs.push(`Alpaca account: $${finalValue.toFixed(2)} portfolio, $${finalCash.toFixed(2)} cash`);
    } catch {
      const { data: prevPortfolio } = await db
        .from("portfolio_state")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .single();
      const previousTotal = prevPortfolio ? Number(prevPortfolio.total_value) : 10_000;
      finalValue = previousTotal + totalDayPnl;
      finalCash = finalValue;
    }
  } else {
    const { data: prevPortfolio } = await db
      .from("portfolio_state")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();
    const previousTotal = prevPortfolio ? Number(prevPortfolio.total_value) : 10_000;
    finalValue = previousTotal + totalDayPnl;
    finalCash = finalValue;
  }

  await db.from("portfolio_state").insert({
    total_value: finalValue,
    cash_available: finalCash,
    day_pnl_dollars: totalDayPnl,
    day_pnl_percent: finalValue > 0 ? (totalDayPnl / (finalValue - totalDayPnl)) * 100 : 0,
    total_pnl_dollars: finalValue - 10_000,
    total_pnl_percent: ((finalValue - 10_000) / 10_000) * 100,
    position_count: 0,
    max_positions: 5,
  });

  logs.push(`EOD Summary: Day P&L $${totalDayPnl.toFixed(2)} | Portfolio $${finalValue.toFixed(2)}`);

  // ── Claude End-of-Day Reflection ──
  const claude = new ClaudeAnalysisService(db);
  if (claude.isAvailable && positions.length > 0) {
    try {
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

      const tradeData = positions.map((pos) => ({
        ticker: pos.ticker as string,
        pnlDollars: Number(pos.pnl_dollars),
        pnlPercent: Number(pos.pnl_percent),
        convictionAtEntry: Number(pos.conviction_at_entry),
        exitReason: "eod" as const,
      }));

      const prompt = eodReflectionPrompt(tradeData, totalDayPnl, macroCtx);
      const { data: reflection } = await claude.analyze<EodResult>({
        prompt,
        stage: "eod",
        runDate,
        maxTokens: 768,
      });

      if (reflection) {
        logs.push(`Claude EOD: win rate ${reflection.winRate}%, best layer=${reflection.bestSignalLayer}, worst=${reflection.worstSignalLayer}`);
        for (const learning of reflection.learnings ?? []) {
          logs.push(`  Learning: ${learning}`);
        }
        if (reflection.tomorrowAdjustments) {
          logs.push(`  Tomorrow: ${reflection.tomorrowAdjustments}`);
        }

        await db.from("signal_events").insert({
          ticker: "PORTFOLIO",
          layer: "claude",
          message: `EOD: ${reflection.learnings?.[0] ?? "Day reviewed"} | Best: ${reflection.bestSignalLayer}`,
          impact: totalDayPnl >= 0 ? "bullish" : "bearish",
          run_date: runDate,
        });
      }
    } catch (err) {
      logs.push(`Claude EOD reflection error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "eod_review");
}
