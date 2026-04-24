import { atr, closes, keltner } from "../indicators";
import type { Strategy, StrategyContext, StrategySignal } from "../types";

const DEFAULTS = {
  kcPeriod: 20,
  kcMult: 2.0,
  atrPeriod: 14,
  atrStopMult: 1.5,
  rewardMult: 2.0,
  volumeSpikeMult: 1.5, // placeholder: require recent volume > 1.5x its sma
};

/**
 * Keltner-channel breakout with ATR stops.
 *
 * **STUB** — interface-complete, returns null in v1. Kept in the registry so
 * the ensemble and backtest harness already know how to route it; activate
 * by flipping `enabled` in the strategy-registry config once we have enough
 * BTC history to validate the edge.
 */
export function volBreakoutATR(overrides: Partial<typeof DEFAULTS> = {}): Strategy {
  const params = { ...DEFAULTS, ...overrides };
  const warmup = Math.max(params.kcPeriod + 2, params.atrPeriod + 2);

  return {
    id: "vol-breakout-atr",
    params,
    warmupBars: warmup,
    onCandle(ctx: StrategyContext): StrategySignal | null {
      const candles = ctx.candles.toArray();
      if (candles.length < warmup) return null;

      // Indicator computation retained so the strategy is wired end-to-end
      // (this surfaces any type/schema issues during build), but no signal
      // is emitted until the strategy is validated.
      ctx.indicators.get(`kc:${params.kcPeriod}:${params.kcMult}`, () =>
        keltner(candles, params.kcPeriod, params.kcMult),
      );
      ctx.indicators.get(`atr:${params.atrPeriod}`, () => atr(candles, params.atrPeriod));
      ctx.indicators.get(`close`, () => closes(candles));

      return null;
    },
  };
}
