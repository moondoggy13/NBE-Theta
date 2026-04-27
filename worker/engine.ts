/**
 * Wires the signal library to live events. Each candle close:
 *   1. candle → ring buffer (handled upstream in feed)
 *   2. run every enabled strategy's onCandle
 *   3. aggregate via either legacy ensemble OR new master signal
 *   4. hand to ExecutionManager
 *
 * Phase-1 (Stage 12): adds a `useMaster` flag. When on, signals route
 * through the regime-conditional `master()` aggregator that takes an HMM
 * filtered posterior and a (K×R) weight matrix. When off, the legacy
 * `aggregate()` is used so paper-mode behavior is unchanged.
 */
import { aggregate, type EnsembleOptions } from "../src/lib/signals/ensemble";
import { master, type MasterOptions, type MasterWeights } from "../src/lib/signals/master";
import { makeIndicatorCache } from "../src/lib/signals/ring-buffer";
import { strategyRegistry } from "../src/lib/signals";
import type { Strategy, StrategyContext, StrategySignal } from "../src/lib/signals/types";
import type { RegimePosterior } from "../src/lib/regime/types";
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
  const ctx = makeContext(strategies, state, symbol);
  const signals: (StrategySignal | null)[] = strategies.map((s) => s.onCandle(ctx));
  return { decision: aggregate(signals, ensembleOpts), signals };
}

/**
 * Phase-1 master-signal evaluation. Returns the same shape as `evaluate()`
 * but with a `MasterDecision` (which is a strict superset of EnsembleDecision).
 */
export function evaluateMaster(
  strategies: readonly Strategy[],
  state: FeedState,
  weights: MasterWeights,
  posterior: RegimePosterior | null,
  symbol: string,
  opts: MasterOptions = {},
) {
  const ctx = makeContext(strategies, state, symbol);
  const signals: (StrategySignal | null)[] = strategies.map((s) => s.onCandle(ctx));
  const decision = master(signals, weights, posterior, opts);
  return { decision, signals };
}

function makeContext(
  _strategies: readonly Strategy[],
  state: FeedState,
  symbol: string,
): StrategyContext {
  return {
    now: Date.now(),
    symbol,
    candles: state.candles,
    ticks: state.ticks,
    indicators: makeIndicatorCache(),
    params: {},
  };
}
