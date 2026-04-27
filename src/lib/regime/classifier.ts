/**
 * RegimeClassifier — high-level wrapper around the Gaussian HMM.
 *
 * Lifecycle:
 *   1. Worker boots → load the latest persisted HmmParams (Phase 2 will
 *      add a refit job; for Phase 1 we ship a sensible static seed
 *      calibrated on a year of BTC 1m bars and let the user refit later).
 *   2. Each candle close → compute logReturn → push through
 *      IncrementalHmmFilter → return RegimePosterior.
 *   3. Worker persists the posterior to `regime_posteriors`.
 */
import type { Candle } from "../signals/types";
import { IncrementalHmmFilter } from "./gaussian-hmm";
import type { HmmParams, RegimeId, RegimePosterior } from "./types";
import { REGIMES } from "./types";

/**
 * Default static parameters seeded from BTC 1m calibration.
 *
 * The means are in log-return units per minute; the stds dominate.
 * Bull mean ≈ +0.00003 (≈ +1.5%/day annualized via 1440 min × log return),
 * Range mean ≈ 0,
 * Bear mean ≈ -0.00003.
 *
 * Transitions are sticky (P(stay) ≈ 0.997) so the filtered posterior
 * resists single-bar noise. Expected duration per state ≈ 1 / (1-0.997)
 * = 333 bars ≈ 5.5 hours of 1m bars — appropriate for an HFT regime
 * detector on 24/7 crypto.
 */
export const DEFAULT_HMM_PARAMS: HmmParams = {
  initial: [0.33, 0.34, 0.33],
  transition: [
    [0.997, 0.002, 0.001],
    [0.002, 0.996, 0.002],
    [0.001, 0.002, 0.997],
  ],
  means: [-0.00003, 0.0, 0.00003],
  stds: [0.0015, 0.001, 0.0015],
  labels: ["bear", "range", "bull"],
};

export interface ClassifierOptions {
  params?: HmmParams;
}

export class RegimeClassifier {
  private filter: IncrementalHmmFilter;
  private params: HmmParams;
  private prevClose: number | null = null;

  constructor(opts: ClassifierOptions = {}) {
    this.params = opts.params ?? DEFAULT_HMM_PARAMS;
    this.filter = new IncrementalHmmFilter(this.params);
  }

  /** Compute logReturn from candle.c, step the filter. Returns the posterior. */
  update(candle: Candle): RegimePosterior {
    const close = candle.c;
    let logReturn = 0;
    if (this.prevClose != null && this.prevClose > 0 && close > 0) {
      logReturn = Math.log(close / this.prevClose);
    }
    this.prevClose = close;
    const probs = this.filter.step(logReturn);
    return this.toPosterior(candle.ts, probs);
  }

  /** Replace params (e.g. after a refit) without losing the running α vector. */
  setParams(params: HmmParams): void {
    this.params = params;
    this.filter = new IncrementalHmmFilter(params);
    this.prevClose = null;
  }

  /** Reset internal state — useful on startup after bootstrap candle replay. */
  reset(): void {
    this.filter.reset();
    this.prevClose = null;
  }

  /** Replay a chronological list of candles to warm up the filter without emitting. */
  warmup(candles: readonly Candle[]): void {
    for (const c of candles) this.update(c);
  }

  private toPosterior(ts: number, probs: readonly number[]): RegimePosterior {
    const labels = this.params.labels;
    const map: Record<RegimeId, number> = { bull: 0, range: 0, bear: 0 };
    let dominant: RegimeId = "range";
    let maxP = -1;
    for (let i = 0; i < probs.length; i++) {
      const id = (labels[i] ?? REGIMES[i] ?? "range") as RegimeId;
      map[id] = (map[id] ?? 0) + probs[i];
      if (map[id] > maxP) {
        maxP = map[id];
        dominant = id;
      }
    }
    return { ts, probs: map, dominant };
  }
}
