import { atr, closes as closeOf, keltner, sma, volumes as volOf } from "../indicators";
import type { Strategy, StrategyContext, StrategySignal } from "../types";

const DEFAULTS = {
  kcPeriod: 20,
  kcMult: 2.0,
  atrPeriod: 14,
  atrStopMult: 1.5,
  rewardMult: 2.0,
  /** Volume confirmation: breakout bar volume must be ≥ this × mean(vol[period]). */
  volumeMult: 1.5,
  /** Minimum |z| above/below band to count as a real breakout. */
  minZ: 0.25,
};

/**
 * Volatility breakout via Keltner channels with ATR + volume confirmation.
 *
 *   Long  if close > KC.upper + minZ · ATR   AND  volume > volumeMult · SMA(volume, period)
 *   Short if close < KC.lower − minZ · ATR   AND  same volume condition
 *
 * Score scales with the standardized distance from the band (clamped).
 * Confidence scales with the volume confirmation strength.
 *
 * Replaces the v1 stub `vol-breakout-atr.ts` with a real Keltner-based
 * implementation. The stub still exists in the registry for backwards
 * compat; new code should use this one.
 */
export function volBreakoutKeltner(overrides: Partial<typeof DEFAULTS> = {}): Strategy {
  const params = { ...DEFAULTS, ...overrides };
  const warmup = Math.max(params.kcPeriod, params.atrPeriod) + 2;

  return {
    id: "vol-breakout-keltner",
    params,
    warmupBars: warmup,
    onCandle(ctx: StrategyContext): StrategySignal | null {
      const candles = ctx.candles.toArray();
      if (candles.length < warmup) return null;

      const c = closeOf(candles);
      const v = volOf(candles);
      const i = candles.length - 1;
      const close = c[i];

      const kc = ctx.indicators.get(`kc:${params.kcPeriod}:${params.kcMult}`, () =>
        keltner(candles, params.kcPeriod, params.kcMult),
      );
      const a = ctx.indicators.get(`atr:${params.atrPeriod}`, () =>
        atr(candles, params.atrPeriod),
      );
      const volSma = ctx.indicators.get(`sma:vol:${params.kcPeriod}`, () =>
        sma(v, params.kcPeriod),
      );

      const upper = kc.upper[i];
      const lower = kc.lower[i];
      const middle = kc.middle[i];
      const atrV = a[i];
      const volMean = volSma[i];

      if (![upper, lower, middle, atrV, volMean].every(Number.isFinite) || atrV <= 0) {
        return null;
      }

      const features: Record<string, number> = {
        upper, lower, middle, atr: atrV, volMean, volNow: v[i],
      };

      // Standardized distance above/below the relevant band.
      const zUp = (close - upper) / atrV;
      const zDn = (lower - close) / atrV;
      features.zUp = zUp;
      features.zDn = zDn;

      const volConfirm = v[i] >= params.volumeMult * volMean;
      features.volConfirm = volConfirm ? 1 : 0;

      if (!volConfirm) {
        return mkSignal("flat", 0, 0.1, ctx.now, features);
      }

      if (zUp > params.minZ) {
        const score = Math.tanh(zUp / 2);
        const confidence = Math.min(1, v[i] / (params.volumeMult * volMean) - 1 + 0.2);
        const stopDist = params.atrStopMult * atrV;
        const entryHint = {
          price: close,
          stop: close - stopDist,
          target: close + stopDist * params.rewardMult,
        };
        return mkSignal("long", score, confidence, ctx.now, features, entryHint);
      }
      if (zDn > params.minZ) {
        const score = -Math.tanh(zDn / 2);
        const confidence = Math.min(1, v[i] / (params.volumeMult * volMean) - 1 + 0.2);
        const stopDist = params.atrStopMult * atrV;
        const entryHint = {
          price: close,
          stop: close + stopDist,
          target: close - stopDist * params.rewardMult,
        };
        return mkSignal("short", score, confidence, ctx.now, features, entryHint);
      }
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
  return { strategyId: "vol-breakout-keltner", ts, side, score, confidence, features, entryHint };
}
