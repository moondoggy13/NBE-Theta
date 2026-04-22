import type { SupabaseClient } from "@supabase/supabase-js";
import {
  paperClient,
  liveClient,
  liveTradingEnabled,
  executionClients,
  getLatestPrice,
  type AlpacaClient,
  type AlpacaAccount,
} from "../../src/server/services/alpaca/client";
import { logger } from "../lib/logger";

const POSITION_SIZE_PCT = 0.02; // 2% of portfolio per position
const STOP_LOSS_PCT = 0.06;     // 6% below entry (middle of 5-8% range)
const TARGET_PCT = 0.15;        // 15% above entry (risk-reward ~2.5:1)

export async function runExecution(db: SupabaseClient, runDate: string) {
  const logs: string[] = [];
  const brokers = executionClients();
  const usePaper = paperClient.available;
  const useLive = liveTradingEnabled();

  if (brokers.length === 0) {
    logs.push("Execution stage — database-only mode (no Alpaca credentials)");
  } else {
    logs.push(
      `Execution stage — submitting to ${brokers.map((b) => b.mode).join(" + ")} ` +
        `(paper=${usePaper}, live=${useLive})`
    );
  }

  // ── Per-broker account snapshot used for sizing ──
  const accounts = new Map<AlpacaClient, AlpacaAccount>();
  for (const broker of brokers) {
    try {
      const acct = await broker.getAccount();
      accounts.set(broker, acct);
      logs.push(
        `${broker.mode}: $${parseFloat(acct.portfolio_value).toFixed(2)} portfolio, ` +
          `$${parseFloat(acct.buying_power).toFixed(2)} buying power`
      );
    } catch (err) {
      logs.push(
        `${broker.mode} account error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Sizing/DB writes are anchored on paper (the algorithm's source of truth).
  // Live mirrors the same trades, sized to live's own portfolio.
  let totalValue: number;
  let cashAvailable: number;
  const paperAccount = accounts.get(paperClient);

  if (paperAccount) {
    totalValue = parseFloat(paperAccount.portfolio_value);
    cashAvailable = parseFloat(paperAccount.buying_power);
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

    // Get live price from Alpaca data feed if any broker is wired up
    if (brokers.length > 0) {
      try {
        entryPrice = await getLatestPrice(stock.ticker);
      } catch {
        entryPrice = Number(stock.current_price) || 100;
        logs.push(`${stock.ticker}: price fetch failed, using ${entryPrice}`);
      }
    } else {
      entryPrice = Number(stock.current_price) || 100;
    }

    // Paper sizing drives DB record; live sizes from its own portfolio below.
    const paperPositionValue = totalValue * POSITION_SIZE_PCT;
    const paperShares = Math.floor(paperPositionValue / entryPrice);

    if (paperShares <= 0) {
      logs.push(`${stock.ticker}: $${entryPrice} too expensive for 2% sizing ($${paperPositionValue.toFixed(0)}) — skipping`);
      continue;
    }

    if (cashAvailable < paperShares * entryPrice) {
      logs.push(`${stock.ticker}: insufficient paper buying power ($${cashAvailable.toFixed(0)} < $${(paperShares * entryPrice).toFixed(0)}) — skipping`);
      continue;
    }

    // ── Fan out market order to every active broker ──
    let filledPrice = entryPrice;
    let filledShares = paperShares;
    let paperOk = brokers.length === 0; // DB-only mode: treat as success
    const submissions: string[] = [];

    for (const broker of brokers) {
      const acct = accounts.get(broker);
      const brokerTotal = acct ? parseFloat(acct.portfolio_value) : totalValue;
      const brokerCash = acct ? parseFloat(acct.buying_power) : cashAvailable;
      const brokerShares = Math.floor((brokerTotal * POSITION_SIZE_PCT) / entryPrice);

      if (brokerShares <= 0 || brokerCash < brokerShares * entryPrice) {
        logs.push(`${stock.ticker}: ${broker.mode} skipped (shares=${brokerShares}, cash=$${brokerCash.toFixed(0)})`);
        continue;
      }

      try {
        const order = await broker.submitOrder({
          symbol: stock.ticker,
          qty: brokerShares,
          side: "buy",
          type: "market",
          time_in_force: "day",
        });
        submissions.push(`${broker.mode}#${order.id}(${brokerShares})`);
        logger.info(`  ${broker.mode} order: ${stock.ticker} x${brokerShares} — ${order.status}`);

        if (broker.mode === "paper") {
          paperOk = true;
          if (order.filled_avg_price) {
            filledPrice = parseFloat(order.filled_avg_price);
            filledShares = parseInt(order.filled_qty, 10);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logs.push(`${stock.ticker}: ${broker.mode} order FAILED — ${msg}`);
        logger.info(`  ${broker.mode} order failed: ${stock.ticker} — ${msg}`);
      }
    }

    if (!paperOk) {
      logs.push(`${stock.ticker}: paper submission failed — skipping DB record`);
      continue;
    }

    if (submissions.length > 0) {
      logs.push(`${stock.ticker}: submitted ${submissions.join(", ")}`);
    }

    // ── Record position in Supabase (paper-anchored) ──
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

    await db.from("signal_events").insert({
      ticker: stock.ticker,
      layer: "technical",
      message: `${brokers.length > 0 ? (useLive ? "Paper+Live" : "Paper") : "Sim"} position opened: ${filledShares} shares @ $${filledPrice.toFixed(2)}`,
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
