import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAvailable as alpacaAvailable,
  getAccount,
  submitOrder,
  getLatestPrice,
} from "../../src/server/services/alpaca/client";
import { logger } from "../lib/logger";

const POSITION_SIZE_PCT = 0.02; // 2% of portfolio per position
const STOP_LOSS_PCT = 0.06;     // 6% below entry (middle of 5-8% range)
const TARGET_PCT = 0.15;        // 15% above entry (risk-reward ~2.5:1)

export async function runExecution(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];
  const useAlpaca = alpacaAvailable();
  logs.push(`Execution stage — ${useAlpaca ? "LIVE Alpaca paper trading" : "database-only mode"}`);

  // ── Get Alpaca account or fallback portfolio state ──
  let totalValue: number;
  let cashAvailable: number;

  if (useAlpaca) {
    try {
      const account = await getAccount();
      totalValue = parseFloat(account.portfolio_value);
      cashAvailable = parseFloat(account.buying_power);
      logs.push(`Alpaca account: $${totalValue.toFixed(2)} portfolio, $${cashAvailable.toFixed(2)} buying power`);
    } catch (err) {
      logs.push(`Alpaca account error: ${err instanceof Error ? err.message : String(err)} — falling back to DB`);
      const { data: portfolioRow } = await db
        .from("portfolio_state")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .single();
      totalValue = portfolioRow ? Number(portfolioRow.total_value) : 10_000;
      cashAvailable = portfolioRow ? Number(portfolioRow.cash_available) : 10_000;
    }
  } else {
    const { data: portfolioRow } = await db
      .from("portfolio_state")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single();
    totalValue = portfolioRow ? Number(portfolioRow.total_value) : 10_000;
    cashAvailable = portfolioRow ? Number(portfolioRow.cash_available) : 10_000;
  }

  // ── Check kill switch ──
  const { data: portfolioRow } = await db
    .from("portfolio_state")
    .select("kill_switch_active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (portfolioRow?.kill_switch_active) {
    logs.push("KILL SWITCH ACTIVE — no new positions");
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "execution");
    return;
  }

  // ── Get universe stocks and current positions ──
  const [{ data: universeStocks }, { data: existingPositions }] = await Promise.all([
    db.from("signal_scores").select("*").eq("run_date", runDate).eq("in_universe", true),
    db.from("positions").select("ticker"),
  ]);

  const heldTickers = new Set((existingPositions ?? []).map((p) => p.ticker));
  const openSlots = 5 - heldTickers.size;

  if (openSlots <= 0) {
    logs.push("All 5 position slots filled — no new entries");
    await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "execution");
    return;
  }

  // ── Enter positions ──
  const newEntries = (universeStocks ?? []).filter((s) => !heldTickers.has(s.ticker)).slice(0, openSlots);
  let totalSpent = 0;

  for (const stock of newEntries) {
    let entryPrice: number;

    // Get live price from Alpaca if available
    if (useAlpaca) {
      try {
        entryPrice = await getLatestPrice(stock.ticker);
      } catch {
        entryPrice = Number(stock.current_price) || 100;
        logs.push(`${stock.ticker}: price fetch failed, using ${entryPrice}`);
      }
    } else {
      entryPrice = Number(stock.current_price) || 100;
    }

    const positionValue = totalValue * POSITION_SIZE_PCT;
    const shares = Math.floor(positionValue / entryPrice);

    if (shares <= 0) {
      logs.push(`${stock.ticker}: $${entryPrice} too expensive for 2% sizing ($${positionValue.toFixed(0)}) — skipping`);
      continue;
    }

    if (cashAvailable < shares * entryPrice) {
      logs.push(`${stock.ticker}: insufficient buying power ($${cashAvailable.toFixed(0)} < $${(shares * entryPrice).toFixed(0)}) — skipping`);
      continue;
    }

    // ── Place Alpaca order ──
    let filledPrice = entryPrice;
    let filledShares = shares;

    if (useAlpaca) {
      try {
        const order = await submitOrder({
          symbol: stock.ticker,
          qty: shares,
          side: "buy",
          type: "market",
          time_in_force: "day",
        });

        logs.push(`${stock.ticker}: Alpaca order ${order.id} submitted (${shares} shares, market)`);
        logger.info(`  order submitted: ${stock.ticker} x${shares} — ${order.status}`);

        // For market orders, filled_avg_price may not be immediately available
        // We'll use the latest price as the estimate and sync later
        if (order.filled_avg_price) {
          filledPrice = parseFloat(order.filled_avg_price);
          filledShares = parseInt(order.filled_qty, 10);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.push(`${stock.ticker}: Alpaca order FAILED — ${msg}`);
        logger.info(`  order failed: ${stock.ticker} — ${msg}`);
        continue; // Skip this stock, don't record position
      }
    }

    // ── Record position in Supabase ──
    const stopLoss = Math.round(filledPrice * (1 - STOP_LOSS_PCT) * 100) / 100;
    const target = Math.round(filledPrice * (1 + TARGET_PCT) * 100) / 100;

    await db.from("positions").upsert({
      ticker: stock.ticker,
      name: stock.name,
      shares: filledShares,
      entry_price: filledPrice,
      current_price: filledPrice,
      stop_loss: stopLoss,
      target,
      pnl_dollars: 0,
      pnl_percent: 0,
      conviction_at_entry: stock.conviction_score,
      entered_at: new Date().toISOString(),
      status: "active",
    }, { onConflict: "ticker" });

    totalSpent += filledShares * filledPrice;
    logs.push(`ENTERED ${stock.ticker}: ${filledShares} shares @ $${filledPrice.toFixed(2)} | SL $${stopLoss} | TGT $${target}`);
    logger.info(`  executed: ${stock.ticker} x${filledShares} @ $${filledPrice.toFixed(2)}`);

    // Emit signal event
    await db.from("signal_events").insert({
      ticker: stock.ticker,
      layer: "technical",
      message: `${useAlpaca ? "Paper" : "Sim"} position opened: ${filledShares} shares @ $${filledPrice.toFixed(2)}`,
      impact: "bullish",
      run_date: runDate,
    });
  }

  // ── Update portfolio state ──
  const { data: allPositions } = await db.from("positions").select("*");
  const positionMarketValue = (allPositions ?? []).reduce(
    (sum, p) => sum + Number(p.shares) * Number(p.current_price), 0
  );
  const newCash = cashAvailable - totalSpent;

  await db.from("portfolio_state").insert({
    total_value: newCash + positionMarketValue,
    cash_available: newCash,
    day_pnl_dollars: 0,
    day_pnl_percent: 0,
    total_pnl_dollars: (newCash + positionMarketValue) - 10_000,
    total_pnl_percent: ((newCash + positionMarketValue) - 10_000) / 10_000 * 100,
    position_count: (allPositions ?? []).length,
    max_positions: 5,
  });

  logs.push(`Portfolio: ${(allPositions ?? []).length} positions, $${newCash.toFixed(2)} cash, $${(newCash + positionMarketValue).toFixed(2)} total`);
  await db.from("pipeline_runs").update({ logs }).eq("run_date", runDate).eq("stage_id", "execution");
}
