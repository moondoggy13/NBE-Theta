#!/usr/bin/env tsx
/**
 * Run a backtest against an NDJSON candle file.
 *
 *   pnpm backtest -- --strategy mean-reversion-bb \
 *     --data data/btc-1m-2024.ndjson \
 *     --start-equity 25000 --risk-per-trade 0.02
 *
 * If SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, the run is
 * persisted to the `backtest_runs` table.
 */
import fs from "node:fs";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { runBacktest } from "../src/lib/backtest/engine";
import { strategyRegistry, type StrategyId } from "../src/lib/signals";
import type { Candle } from "../src/lib/signals/types";
import { INTERVAL_MINUTES, type Interval } from "../src/lib/feed/types";

async function readNdjson(path: string): Promise<Candle[]> {
  const out: Candle[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      strategy:       { type: "string", multiple: true },
      data:           { type: "string" },
      symbol:         { type: "string", default: "BTC-USD" },
      interval:       { type: "string", default: "1m" },
      "start-equity": { type: "string", default: "25000" },
      "risk-per-trade": { type: "string", default: "0.02" },
      "slippage-bps": { type: "string", default: "1" },
      "fee-bps":      { type: "string", default: "5" },
      save:           { type: "boolean", default: false },
    },
  });

  if (!values.data) {
    console.error("Missing --data <ndjson path>");
    process.exit(1);
  }

  const strategyIds = (values.strategy ?? ["mean-reversion-bb"]) as StrategyId[];
  const unknown = strategyIds.filter((id) => !(id in strategyRegistry));
  if (unknown.length) {
    console.error(`Unknown strategies: ${unknown.join(", ")}`);
    console.error(`Available: ${Object.keys(strategyRegistry).join(", ")}`);
    process.exit(1);
  }

  const strategies = strategyIds.map((id) => strategyRegistry[id].build());
  const weights = Object.fromEntries(strategyIds.map((id) => [id, 1]));
  const interval = values.interval as Interval;

  console.log(`Loading candles from ${values.data}...`);
  const candles = await readNdjson(values.data);
  console.log(`Running backtest on ${candles.length} ${interval} candles with ${strategyIds.join(", ")}`);

  const startEquity = Number(values["start-equity"]);
  const result = runBacktest({
    candles,
    strategies,
    ensemble: { weights },
    symbol: values.symbol,
    startEquity,
    riskPerTrade: Number(values["risk-per-trade"]),
    slippageBps: Number(values["slippage-bps"]),
    feeBps: Number(values["fee-bps"]),
    barMinutes: INTERVAL_MINUTES[interval],
  });

  console.log();
  console.log("── Metrics ──────────────────────────────────────────────");
  console.log(JSON.stringify(result.metrics, null, 2));
  console.log();
  console.log(`Trades: ${result.trades.length}`);
  if (result.trades.length) {
    const wins = result.trades.filter((t) => t.pnl > 0).length;
    console.log(`  wins:    ${wins} (${((wins / result.trades.length) * 100).toFixed(1)}%)`);
    console.log(`  largest: ${Math.max(...result.trades.map((t) => t.pnl)).toFixed(2)}`);
    console.log(`  worst:   ${Math.min(...result.trades.map((t) => t.pnl)).toFixed(2)}`);
  }

  if (values.save) {
    await saveToSupabase({
      strategyIds,
      symbol: values.symbol!,
      interval,
      params: { weights, riskPerTrade: Number(values["risk-per-trade"]), startEquity },
      candles,
      result,
    });
  }
}

async function saveToSupabase(args: {
  strategyIds: readonly string[];
  symbol: string;
  interval: string;
  params: Record<string, unknown>;
  candles: readonly Candle[];
  result: ReturnType<typeof runBacktest>;
}): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn("Supabase env not set — skipping save.");
    return;
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await sb.from("backtest_runs").insert({
    engine: "ts",
    strategy_id: args.strategyIds.join("+"),
    symbol: args.symbol,
    interval: args.interval,
    params: args.params,
    from_ts: new Date(args.candles[0].ts).toISOString(),
    to_ts: new Date(args.candles[args.candles.length - 1].ts).toISOString(),
    metrics: args.result.metrics,
    completed_at: new Date().toISOString(),
  });
  if (error) console.error(`Supabase save error: ${error.message}`);
  else console.log("Saved to backtest_runs.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
