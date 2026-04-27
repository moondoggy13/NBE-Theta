/**
 * Regime classifier types — single-asset 3-state HMM.
 *
 * The classifier observes a 1-D feature stream (currently log return,
 * extensible to multi-D) and returns the FILTERED posterior P(r_t | y_{1:t})
 * each step. Filtered (forward) — never smoothed (forward-backward) —
 * because real-time decisions cannot use future data.
 */

export type RegimeId = "bull" | "range" | "bear";
export const REGIMES: readonly RegimeId[] = ["bull", "range", "bear"] as const;

export interface RegimeFeatures {
  ts: number;
  /** Log return between previous and current close. */
  logReturn: number;
  /** EWMA realized vol (annualized) at this bar. */
  realizedVol: number;
}

/**
 * Gaussian HMM parameters for the (logReturn, ?realizedVol) observation.
 * Phase 1 uses 1-D observations (logReturn) — realizedVol enters via the
 * mean/variance estimates rather than a second observed dimension.
 */
export interface HmmParams {
  /** Initial state distribution; sums to 1, length K. */
  initial: number[];
  /** K×K row-stochastic transition matrix; rows sum to 1. */
  transition: number[][];
  /** State-conditional Gaussian means, length K. */
  means: number[];
  /** State-conditional Gaussian std-devs, length K (must be > 0). */
  stds: number[];
  /** Sorted state index → RegimeId. After fitting, we sort states by mean
   *  and label them { bear, range, bull } from low → high. */
  labels: RegimeId[];
}

export interface RegimePosterior {
  ts: number;
  /** Filtered posterior over states aligned with `labels` order. */
  probs: Record<RegimeId, number>;
  dominant: RegimeId;
  /** Diagnostic: log-likelihood of the latest observation under the model. */
  logLik?: number;
}
