/**
 * Deterministic candle-replay backtester.
 *
 * Walks a strategy bar-by-bar over historical candles with a fixed
 * starting equity. One position open at a time (BTC-only v1).
 * Intra-bar stop/target checks assume pessimistic ordering: if both
 * levels are crossed within the same bar, the stop wins for longs
 * (a real bar could have traded stop-first) and the target wins for
 * shorts — symmetric unfavorable assumption.
 */
import { RingBuffer, makeIndicatorCache } from "../signals/ring-buffer";
import { aggregate, type EnsembleOptions } from "../signals/ensemble";
import type { Candle, Strategy, StrategyContext } from "../signals/types";
import { computeMetrics, type EquityPoint, type Metrics, type TradeRecord } from "./metrics";

export interface BacktestOptions {
  candles: readonly Candle[];
  strategies: readonly Strategy[];
  ensemble: EnsembleOptions;
  symbol?: string;
  startEquity?: number;
  riskPerTrade?: number;  // fraction of equity risked per trade (e.g. 0.02)
  slippageBps?: number;
  feeBps?: number;
  bufferSize?: number;
  barMinutes?: number;
}

export interface BacktestResult {
  metrics: Metrics;
  trades: TradeRecord[];
  equity: EquityPoint[];
  signals: Array<{ ts: number; strategyId: string; side: string; score: number; confidence: number }>;
}

interface OpenPosition {
  side: "long" | "short";
  entryTs: number;
  entryPrice: number;
  qty: number;
  stop: number;
  target: number;
}

export function runBacktest(opts: BacktestOptions): BacktestResult {
  const {
    candles,
    strategies,
    ensemble,
    symbol = "BTC-USD",
    startEquity = 25_000,
    riskPerTrade = 0.02,
    slippageBps = 1,
    feeBps = 5,
    bufferSize = 500,
    barMinutes = 1,
  } = opts;

  const buffer = new RingBuffer<Candle>(bufferSize);
  const indicators = makeIndicatorCache();
  let equity = startEquity;
  let position: OpenPosition | null = null;
  const trades: TradeRecord[] = [];
  const equitySeries: EquityPoint[] = [];
  const signalLog: BacktestResult["signals"] = [];

  const slip = slippageBps / 10_000;
  const fee = feeBps / 10_000;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    buffer.push(bar);
    indicators.clear();

    // Intra-bar exit checks BEFORE new signal (the bar has already traded)
    if (position) {
      const exitInfo = checkIntrabar(bar, position);
      if (exitInfo) {
        const fillPx = applySlippage(exitInfo.price, position.side === "long" ? "sell" : "buy", slip);
        const pnl = realizedPnl(position, fillPx, fee);
        equity += pnl;
        trades.push({
          entryTs: position.entryTs,
          exitTs: bar.ts,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: fillPx,
          qty: position.qty,
          pnl,
          reason: exitInfo.reason,
        });
        position = null;
      }
    }

    // Evaluate strategies on this bar
    const ctx: StrategyContext = {
      now: bar.ts,
      symbol,
      candles: buffer,
      ticks: new RingBuffer(1),
      indicators,
      params: {},
    };
    const signals = strategies.map((s) => {
      const sig = s.onCandle(ctx);
      if (sig) signalLog.push({ ts: sig.ts, strategyId: sig.strategyId, side: sig.side, score: sig.score, confidence: sig.confidence });
      return sig;
    });
    const decision = aggregate(signals, ensemble);

    // Signal-driven exit (flat or reversal)
    if (position) {
      const wantFlat =
        decision.side === "flat" ||
        (position.side === "long" && decision.side === "short") ||
        (position.side === "short" && decision.side === "long");
      if (wantFlat) {
        const fillPx = applySlippage(bar.c, position.side === "long" ? "sell" : "buy", slip);
        const pnl = realizedPnl(position, fillPx, fee);
        equity += pnl;
        trades.push({
          entryTs: position.entryTs,
          exitTs: bar.ts,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: fillPx,
          qty: position.qty,
          pnl,
          reason: "signal",
        });
        position = null;
      }
    }

    // Entry
    if (!position && (decision.side === "long" || decision.side === "short")) {
      const hint = signals.find((s) => s?.side === decision.side && s?.entryHint)?.entryHint;
      const entry = applySlippage(bar.c, decision.side === "long" ? "buy" : "sell", slip);
      const stop = hint?.stop ?? (decision.side === "long" ? entry * 0.98 : entry * 1.02);
      const target = hint?.target ?? (decision.side === "long" ? entry * 1.04 : entry * 0.96);
      const riskPerUnit = Math.abs(entry - stop);
      if (riskPerUnit > 0) {
        const qty = (equity * riskPerTrade) / riskPerUnit;
        position = {
          side: decision.side === "long" ? "long" : "short",
          entryTs: bar.ts,
          entryPrice: entry,
          qty,
          stop,
          target,
        };
        equity -= qty * entry * fee; // entry fee
      }
    }

    // Mark-to-market equity snapshot
    const mtm = position ? markEquity(equity, position, bar.c) : equity;
    equitySeries.push({ ts: bar.ts, equity: mtm });
  }

  // Final flatten at end of series
  if (position && candles.length > 0) {
    const last = candles[candles.length - 1];
    const fillPx = applySlippage(last.c, position.side === "long" ? "sell" : "buy", slip);
    const pnl = realizedPnl(position, fillPx, fee);
    equity += pnl;
    trades.push({
      entryTs: position.entryTs,
      exitTs: last.ts,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: fillPx,
      qty: position.qty,
      pnl,
      reason: "eod",
    });
    equitySeries[equitySeries.length - 1].equity = equity;
    position = null;
  }

  const metrics = computeMetrics(equitySeries, trades, startEquity, barMinutes);
  return { metrics, trades, equity: equitySeries, signals: signalLog };
}

function checkIntrabar(
  bar: Candle,
  pos: OpenPosition,
): { price: number; reason: "stop" | "target" } | null {
  if (pos.side === "long") {
    if (bar.l <= pos.stop) return { price: pos.stop, reason: "stop" };
    if (bar.h >= pos.target) return { price: pos.target, reason: "target" };
  } else {
    if (bar.h >= pos.stop) return { price: pos.stop, reason: "stop" };
    if (bar.l <= pos.target) return { price: pos.target, reason: "target" };
  }
  return null;
}

function applySlippage(price: number, side: "buy" | "sell", slip: number): number {
  return side === "buy" ? price * (1 + slip) : price * (1 - slip);
}

function realizedPnl(pos: OpenPosition, exitPx: number, fee: number): number {
  const gross = pos.side === "long" ? (exitPx - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPx) * pos.qty;
  const exitFee = pos.qty * exitPx * fee;
  return gross - exitFee;
}

function markEquity(cash: number, pos: OpenPosition, mark: number): number {
  const unrealized = pos.side === "long" ? (mark - pos.entryPrice) * pos.qty : (pos.entryPrice - mark) * pos.qty;
  return cash + unrealized;
}
