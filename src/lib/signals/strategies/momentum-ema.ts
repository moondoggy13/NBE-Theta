import { adx, atr, closes, ema } from "../indicators";
import type { Strategy, StrategyContext, StrategySignal } from "../types";

const DEFAULTS = {
  fast: 9,
  slow: 21,
  adxPeriod: 14,
  adxThreshold: 20,
  atrPeriod: 14,
  atrStopMult: 2.0,
  rewardMult: 2.5, // target distance = rewardMult * stop distance
};

/**
 * EMA fast/slow crossover with ADX trend-strength filter.
 * Enters long when fast > slow AND ADX ≥ threshold AND fast is rising.
 * Enters short on the mirror condition. Exits to flat on crossover
 * reversal or ADX collapse below threshold.
 *
 * Stops are ATR-based; targets use a configurable R:R ratio.
 */
export function momentumEMA(overrides: Partial<typeof DEFAULTS> = {}): Strategy {
  const params = { ...DEFAULTS, ...overrides };
  const warmup = Math.max(params.slow + 2, params.adxPeriod * 2 + 1, params.atrPeriod + 2);

  return {
    id: "momentum-ema",
    params,
    warmupBars: warmup,
    onCandle(ctx: StrategyContext): StrategySignal | null {
      const candles = ctx.candles.toArray();
      if (candles.length < warmup) return null;

      const c = closes(candles);
      const { fast, slow, adxPeriod, adxThreshold, atrPeriod, atrStopMult, rewardMult } = params;

      const emaFast = ctx.indicators.get(`ema:close:${fast}`, () => ema(c, fast));
      const emaSlow = ctx.indicators.get(`ema:close:${slow}`, () => ema(c, slow));
      const adxOut = ctx.indicators.get(`adx:${adxPeriod}`, () => adx(candles, adxPeriod));
      const atrOut = ctx.indicators.get(`atr:${atrPeriod}`, () => atr(candles, atrPeriod));

      const i = candles.length - 1;
      const px = c[i];
      const f = emaFast[i];
      const s = emaSlow[i];
      const fPrev = emaFast[i - 1];
      const a = adxOut.adx[i];
      const t = atrOut[i];

      if (![f, s, fPrev, a, t].every(Number.isFinite)) return null;

      const diff = f - s;
      const slope = f - fPrev;
      const trendOn = a >= adxThreshold;

      const features: Record<string, number> = {
        emaFast: f,
        emaSlow: s,
        emaDiffPct: (diff / px) * 100,
        adx: a,
        plusDi: adxOut.plusDi[i],
        minusDi: adxOut.minusDi[i],
        atr: t,
        slope,
      };

      if (!trendOn) {
        return mkSignal("flat", 0, clamp((adxThreshold - a) / adxThreshold, 0, 1), ctx.now, features);
      }
      // Long regime
      if (diff > 0 && slope > 0) {
        const stop = px - atrStopMult * t;
        const target = px + atrStopMult * t * rewardMult;
        const score = tanh(diff / px * 50);
        return mkSignal("long", score, clamp(a / 50, 0, 1), ctx.now, features, { price: px, stop, target });
      }
      // Short regime
      if (diff < 0 && slope < 0) {
        const stop = px + atrStopMult * t;
        const target = px - atrStopMult * t * rewardMult;
        const score = tanh(diff / px * 50);
        return mkSignal("short", score, clamp(a / 50, 0, 1), ctx.now, features, { price: px, stop, target });
      }
      // Crossover but weak slope → flat
      return mkSignal("flat", 0, 0.2, ctx.now, features);
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
  return { strategyId: "momentum-ema", ts, side, score, confidence, features, entryHint };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function tanh(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e2 = Math.exp(2 * x);
  return (e2 - 1) / (e2 + 1);
}
