import { ema } from "../indicators";
import type { Strategy, StrategyContext, StrategySignal } from "../types";

const DEFAULTS = {
  lookbacks: [20, 60, 120],
  /** Bars per "year" for vol scaling — 525 600 for 1m, but the per-LB
   *  scaling collapses to sqrt(L/total) so the precise total cancels.
   *  We use 252 (trading-day convention) to match the research formula. */
  scalingTotal: 252,
  emaPeriod: 9,
  /** Optional ATR-based stop multiplier when entry is taken. */
  atrPeriod: 14,
  atrStopMult: 2.5,
  /** R:R ratio for target. */
  rewardMult: 2.0,
};

/**
 * Time-Series Momentum ensemble — multi-lookback tanh-squashed momentum.
 *
 * For each lookback L ∈ {20, 60, 120}:
 *   z_L = tanh( r_{t-L:t} / (σ_t · sqrt(L / scalingTotal)) )
 *
 * Final score is the mean over L. tanh squashing prevents single-period
 * explosions; the per-LB σ scaling makes signals comparable across windows.
 *
 * The "side" decision uses sign(score). Confidence is |score| in [0,1].
 */
export function tsMomEnsemble(overrides: Partial<typeof DEFAULTS> = {}): Strategy {
  const params = { ...DEFAULTS, ...overrides };
  const warmup = Math.max(...params.lookbacks) + 5;

  return {
    id: "ts-mom-ensemble",
    params: { ...params, lookbacks: params.lookbacks[0] },
    warmupBars: warmup,
    onCandle(ctx: StrategyContext): StrategySignal | null {
      const candles = ctx.candles.toArray();
      if (candles.length < warmup) return null;

      const closes = candles.map((c) => c.c);
      const n = closes.length;
      const lastPrice = closes[n - 1];
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;

      // Per-lookback log return and bar-level σ over the window.
      let sumScore = 0;
      let validLookbacks = 0;
      const features: Record<string, number> = {};

      for (const L of params.lookbacks) {
        if (n < L + 1) continue;
        const past = closes[n - 1 - L];
        if (!Number.isFinite(past) || past <= 0) continue;
        const r = Math.log(lastPrice / past);
        // Bar-level realized stddev of log returns over the window.
        const start = n - 1 - L;
        let mean = 0;
        const lrs: number[] = [];
        for (let i = start + 1; i <= n - 1; i++) {
          if (closes[i - 1] <= 0) continue;
          lrs.push(Math.log(closes[i] / closes[i - 1]));
        }
        if (lrs.length === 0) continue;
        for (const lr of lrs) mean += lr;
        mean /= lrs.length;
        let variance = 0;
        for (const lr of lrs) variance += (lr - mean) ** 2;
        variance /= lrs.length;
        const sigma = Math.sqrt(variance);
        if (sigma <= 0) continue;

        const denom = sigma * Math.sqrt(L / params.scalingTotal);
        const z = denom > 0 ? r / denom : 0;
        const tanhz = Math.tanh(z);
        sumScore += tanhz;
        validLookbacks += 1;
        features[`lb${L}`] = tanhz;
      }
      if (validLookbacks === 0) return null;

      const score = sumScore / validLookbacks;
      const absScore = Math.abs(score);

      // Weak signal → flat.
      if (absScore < 0.1) {
        return mkSignal("flat", 0, 0.1, ctx.now, features);
      }

      const side: "long" | "short" = score > 0 ? "long" : "short";
      // Optional ATR-based entry hint.
      let entryHint: StrategySignal["entryHint"] | undefined;
      if (n >= params.atrPeriod + 2) {
        const trs: number[] = [];
        for (let i = n - params.atrPeriod; i < n; i++) {
          if (i <= 0) continue;
          const c = candles[i];
          const pc = candles[i - 1].c;
          trs.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
        }
        if (trs.length > 0) {
          const atr = trs.reduce((s, x) => s + x, 0) / trs.length;
          const stopDist = params.atrStopMult * atr;
          const entry = lastPrice;
          const stop = side === "long" ? entry - stopDist : entry + stopDist;
          const target =
            side === "long"
              ? entry + stopDist * params.rewardMult
              : entry - stopDist * params.rewardMult;
          entryHint = { price: entry, stop, target };
          features.atr = atr;
        }
      }

      // Also expose the EMA-fast for diagnostics (replaces single-TF
      // momentum-ema feature comparison).
      try {
        const fast = ema(closes, params.emaPeriod);
        if (Number.isFinite(fast[n - 1])) features.emaFast = fast[n - 1];
      } catch { /* ignore */ }

      return mkSignal(side, score, Math.min(1, absScore), ctx.now, features, entryHint);
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
  return { strategyId: "ts-mom-ensemble", ts, side, score, confidence, features, entryHint };
}
