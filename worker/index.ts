/**
 * Worker entrypoint. Long-lived tick loop:
 *   Coinbase WS → ring buffers → strategies → ensemble → risk → broker.
 *   All meaningful events are mirrored to Supabase for the dashboard.
 *
 * Run modes (set by env):
 *   COINBASE_MODE=paper (default) → MockBrokerClient; no real orders.
 *   COINBASE_MODE=live            → refuses to start unless
 *                                   COINBASE_LIVE=true && CONFIRM_LIVE=YES.
 */
import { loadEnv } from "./lib/env";
import { logger } from "./lib/logger";
import { installShutdown } from "./lib/shutdown";
import { resolveRiskConfig } from "../src/lib/risk/config";
import { buildBroker, ExecutionManager } from "./execution";
import type { MockBrokerClient } from "../src/lib/broker/mock";
import { bootstrapCandles, startFeed } from "./feed";
import { buildEnsembleOptions, buildStrategies, evaluate } from "./engine";
import { currentUtcDay, type RiskState } from "../src/lib/risk/kill-switch";
import { SupabaseSink } from "./supabase-sink";
import { HOT_KEYS, redisClient } from "../src/lib/redis/client";

async function main() {
  const env = loadEnv();
  const cfg = resolveRiskConfig({
    RISK_PRESET: env.RISK_PRESET,
    RISK_START_EQUITY: env.RISK_START_EQUITY,
    RISK_PER_TRADE_PCT: env.RISK_PER_TRADE_PCT,
    RISK_DAILY_STOP_PCT: env.RISK_DAILY_STOP_PCT,
  });

  logger.info({ mode: env.COINBASE_MODE, risk: cfg }, "worker starting");

  const broker = buildBroker(env, cfg);
  const strategies = buildStrategies();
  const ensembleOpts = buildEnsembleOptions(strategies);
  logger.info(
    { strategies: strategies.map((s) => s.id), weights: ensembleOpts.weights },
    "strategies loaded",
  );

  let riskState: RiskState = {
    killSwitchActive: false,
    autonomousExecution: env.COINBASE_MODE === "paper",
    dayStartEquity: cfg.startEquity,
    dailyLossDollars: 0,
    dayAnchorUtc: currentUtcDay(),
  };

  const sink = new SupabaseSink({
    logger,
    applyRiskState: (patch) => {
      riskState = { ...riskState, ...patch };
    },
  });

  const redis = redisClient();
  // Tick-rate rolling counter (last 60s)
  const tickTimes: number[] = [];

  const execution = new ExecutionManager({
    env,
    cfg,
    symbol: env.SYMBOL,
    broker,
    logger,
    getRiskState: () => riskState,
    setRiskState: (patch) => {
      riskState = { ...riskState, ...patch };
    },
  });

  broker.onFill(async (fill, order) => {
    await Promise.all([sink.recordFill(fill), sink.recordOrder(order)]);
  });

  logger.info({ symbol: env.SYMBOL }, "bootstrapping recent candles");
  const bootstrap = await bootstrapCandles(env.SYMBOL, 200).catch((err) => {
    logger.warn({ err: err.message }, "bootstrap candles failed");
    return [];
  });
  logger.info({ count: bootstrap.length }, "bootstrap complete");

  const { feed, state } = startFeed({
    symbol: env.SYMBOL,
    bufferTicks: 5_000,
    bufferCandles: 1_000,
    logger,
    onTick: (tick) => {
      const mock = broker as unknown as MockBrokerClient;
      if (typeof mock.setReferencePrice === "function") mock.setReferencePrice(tick.price);
      void execution.onPriceUpdate(tick.price);

      // Hot cache: latest price + rolling tick rate. Fire-and-forget; Redis
      // unavailability is logged elsewhere and shouldn't block the loop.
      if (redis) {
        const now = Date.now();
        tickTimes.push(now);
        while (tickTimes.length && tickTimes[0] < now - 60_000) tickTimes.shift();
        void redis.mset({
          [HOT_KEYS.lastPrice]: String(tick.price),
          [HOT_KEYS.lastPriceTs]: String(now),
          [HOT_KEYS.tickRate]: String(tickTimes.length),
        }).catch(() => {});
      }
    },
    onCandleClose: async (_candle, fs) => {
      const { decision, signals } = evaluate(strategies, fs, ensembleOpts, env.SYMBOL);
      logger.debug(
        {
          side: decision.side,
          score: decision.score.toFixed(4),
          conf: decision.confidence.toFixed(2),
        },
        "ensemble decision",
      );
      for (const s of signals) if (s) sink.recordSignal(env.SYMBOL, s);
      sink.recordEnsembleSignal(env.SYMBOL, decision);

      void execution.onDecision(decision, fs.lastPrice);

      try {
        const acct = await broker.getAccount();
        const positions = await broker.getPositions();
        const unreal = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
        const realized = positions.reduce((s, p) => s + p.realizedPnl, 0);
        const dd =
          riskState.dayStartEquity > 0
            ? Math.max(0, (riskState.dayStartEquity - acct.equity) / riskState.dayStartEquity * 100)
            : 0;
        sink.recordPnl(acct.equity, realized, unreal, dd);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "pnl snapshot failed");
      }
    },
  });

  for (const c of bootstrap) state.candles.push(c);

  installShutdown(logger, async () => {
    await feed.close();
    sink.close();
    logger.info("feed closed");
  });

  await feed.connect();
}

main().catch((err) => {
  logger.fatal({ err }, "fatal worker error");
  process.exit(1);
});
