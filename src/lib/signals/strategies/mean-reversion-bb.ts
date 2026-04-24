import { atr, bollinger, closes, stddev, sma } from "../indicators";
import type { Strategy, StrategyContext, StrategySignal } from "../types";

const DEFAULTS = {
  bbPeriod: 20,
  bbStd: 2,
  atrPeriod: 14,
  atrStopMult: 1.5,
  entryZ: 2.0,
  exitZ: 0.25,
};

/**
 * Bollinger-band / z-score mean reversion.
 * Goes long when price is >entryZ stddevs below the moving average;
 * short when >entryZ above. Exits to flat when |z| drops below exitZ
 * (price has returned toward the mean).
 *
 * Stops are ATR-based; target is the middle band.
 */
export function meanReversionBB(overrides: Partial<typeof DEFAULTS> = {}): Strategy {
  const params = { ...DEFAULTS, ...overrides };
  const warmup = Math.max(params.bbPeriod, params.atrPeriod) + 2;

  return {
    id: "mean-reversion-bb",
    params,
    warmupBars: warmup,
    onCandle(ctx: StrategyContext): StrategySignal | null {
      const candles = ctx.candles.toArray();
      if (candles.length < warmup) return null;

      const c = closes(candles);
      const { bbPeriod, bbStd, atrPeriod, atrStopMult, entryZ, exitZ } = params;

      const bb = ctx.indicators.get(`bb:${bbPeriod}:${bbStd}`, () =>
        bollinger(c, bbPeriod, bbStd),
      );
      const sd = ctx.indicators.get(`sd:${bbPeriod}`, () => stddev(c, bbPeriod));
      const m = ctx.indicators.get(`sma:${bbPeriod}`, () => sma(c, bbPeriod));
      const a = ctx.indicators.get(`atr:${atrPeriod}`, () => atr(candles, atrPeriod));

      const i = candles.length - 1;
      const px = c[i];
      const mid = m[i];
      const sigma = sd[i];
      const atrV = a[i];
      if (!Number.isFinite(mid) || !Number.isFinite(sigma) || sigma === 0 || !Number.isFinite(atrV)) {
        return null;
      }

      const z = (px - mid) / sigma;
      const features: Record<string, number> = {
        zscore: z,
        mid,
        upper: bb.upper[i],
        lower: bb.lower[i],
        atr: atrV,
      };

      // Exit: we've returned near the mean
      if (Math.abs(z) < exitZ) {
        return mkSignal("flat", 0, Math.min(1, 1 - Math.abs(z) / exitZ), ctx.now, features);
      }
      // Entry long: oversold
      if (z <= -entryZ) {
        const stop = px - atrStopMult * atrV;
        return mkSignal("long", clamp(-z / 3, -1, 1), clamp(Math.abs(z) / (entryZ * 1.5), 0, 1), ctx.now, features, {
          price: px,
          stop,
          target: mid,
        });
      }
      // Entry short: overbought
      if (z >= entryZ) {
        const stop = px + atrStopMult * atrV;
        return mkSignal("short", clamp(-z / 3, -1, 1), clamp(Math.abs(z) / (entryZ * 1.5), 0, 1), ctx.now, features, {
          price: px,
          stop,
          target: mid,
        });
      }
      return null;
    },
  };
}

function mkSignal(
  side: StrategySignal["side"],
  score: number,
  confidence: number,
  ts: number,
  features: Record<string, number>,
  entryHint?: StrategySignal["entryHint"],
): StrategySignal {
  return { strategyId: "mean-reversion-bb", ts, side, score, confidence, features, entryHint };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
