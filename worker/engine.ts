/**
 * Wires the signal library to live events. Each candle close:
 *   1. candle → ring buffer (handled upstream in feed)
 *   2. run every enabled strategy's onCandle
 *   3. aggregate → EnsembleDecision
 *   4. hand to ExecutionManager
 */
import { aggregate, type EnsembleOptions } from "../src/lib/signals/ensemble";
import { makeIndicatorCache } from "../src/lib/signals/ring-buffer";
import { strategyRegistry } from "../src/lib/signals";
import type { Strategy, StrategyContext, StrategySignal } from "../src/lib/signals/types";
import type { FeedState } from "./feed";

export function buildStrategies(): Strategy[] {
  return Object.entries(strategyRegistry)
    .filter(([, entry]) => entry.enabled)
    .map(([, entry]) => entry.build());
}

export function buildEnsembleOptions(strategies: Strategy[]): EnsembleOptions {
  const weights: Record<string, number> = {};
  for (const s of strategies) weights[s.id] = 1;
  return { weights };
}

export function evaluate(
  strategies: readonly Strategy[],
  state: FeedState,
  ensembleOpts: EnsembleOptions,
  symbol: string,
) {
  const indicators = makeIndicatorCache();
  const ctx: StrategyContext = {
    now: Date.now(),
    symbol,
    candles: state.candles,
    ticks: state.ticks,
    indicators,
    params: {},
  };
  const signals: (StrategySignal | null)[] = strategies.map((s) => s.onCandle(ctx));
  return { decision: aggregate(signals, ensembleOpts), signals };
}
