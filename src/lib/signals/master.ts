/**
 * Master signal — regime-conditional, IC-weighted aggregation.
 *
 *   S_master(t) = Σ_k [Σ_r p_r(t) · W_{k,r}] · z_k(t)
 *
 * Where:
 *   z_k(t)   = signal-to-z conviction in [-3, +3] from each strategy
 *   p_r(t)   = HMM filtered posterior over regimes (sums to 1)
 *   W_{k,r}  = K×R weight matrix (rolling IC-based; equal-weight at warmup)
 *
 * Falls back gracefully:
 *   - missing posterior → uniform (1/R per regime)
 *   - missing weight cell → 1/K equal weight
 *   - missing strategy signal → contributes 0 to the master score
 *
 * The output is shaped as `EnsembleDecision` (same type the executor reads)
 * so the worker can swap `aggregate()` ↔ `master()` without changing the
 * downstream interface.
 */
import type {
  EnsembleDecision,
  Side,
  StrategySignal,
} from "./types";
import type { RegimeId, RegimePosterior } from "../regime/types";
import { REGIMES } from "../regime/types";

export interface MasterWeights {
  /** weights[strategyId][regime] = weight; missing entries default to 1/K. */
  [strategyId: string]: Partial<Record<RegimeId, number>>;
}

export interface MasterOptions {
  /** Optional discrete-decision threshold (default 0.30). */
  longThreshold?: number;
  shortThreshold?: number;
  /** If provided, only these strategies count toward the master score. */
  strategyIds?: readonly string[];
}

export interface MasterDecision extends EnsembleDecision {
  /** Continuous master score in approximately [-3, +3]. */
  masterScore: number;
  /** Per-strategy z-score after the signal-to-z adapter. */
  perStrategyZ: Record<string, number>;
  /** Effective weight per (strategy, regime) used in this aggregation. */
  effectiveWeights: Array<{ strategyId: string; regime: RegimeId; weight: number; }>;
  /** Posterior used in aggregation (echoed for diagnostics). */
  posterior: Record<RegimeId, number>;
}

// The master score is on the ±3 scale (signalToZ multiplies score · conf · 3).
// To preserve the discrimination level of the legacy `aggregate()` (which used
// 0.30 on a ±1 score scale), the master threshold is 3× the legacy value.
// Tune up if you want fewer/more selective entries.
const DEFAULT_THRESH = { long: 0.90, short: 0.90 };

/**
 * Convert a strategy signal to a signed conviction z-score in [-3, +3].
 *   z = clamp(sign · |score| · 3 · confidence, -3, +3)
 *
 * `flat` signals collapse to z=0 regardless of score/confidence.
 */
export function signalToZ(signal: StrategySignal | null): number {
  if (!signal) return 0;
  const sign = signal.side === "long" ? 1 : signal.side === "short" ? -1 : 0;
  if (sign === 0) return 0;
  const z = sign * Math.abs(signal.score) * 3 * Math.max(0, Math.min(1, signal.confidence));
  return Math.max(-3, Math.min(3, z));
}

export function uniformPosterior(): Record<RegimeId, number> {
  const p: Record<RegimeId, number> = { bull: 0, range: 0, bear: 0 };
  for (const r of REGIMES) p[r] = 1 / REGIMES.length;
  return p;
}

function readPosterior(p?: RegimePosterior | null): Record<RegimeId, number> {
  if (!p) return uniformPosterior();
  // Defensive normalization in case of float drift.
  let s = 0;
  for (const r of REGIMES) s += Math.max(0, p.probs[r] ?? 0);
  if (s <= 0) return uniformPosterior();
  const out: Record<RegimeId, number> = { bull: 0, range: 0, bear: 0 };
  for (const r of REGIMES) out[r] = Math.max(0, p.probs[r] ?? 0) / s;
  return out;
}

/**
 * Aggregate strategy signals into a regime-conditional master decision.
 *
 *   - When `posterior` is omitted: behaves like equal-weight ensemble across
 *     regimes (uniform posterior = 1/3 per regime).
 *   - When `weights` is empty for a strategy: that strategy gets an
 *     equal-weight default of 1 across all regimes (so warmup behavior
 *     matches the legacy `aggregate()` function).
 */
export function master(
  signals: readonly (StrategySignal | null)[],
  weights: MasterWeights,
  posterior: RegimePosterior | null | undefined,
  opts: MasterOptions = {},
): MasterDecision {
  const longT = opts.longThreshold ?? DEFAULT_THRESH.long;
  const shortT = opts.shortThreshold ?? DEFAULT_THRESH.short;
  const allowed = opts.strategyIds ? new Set(opts.strategyIds) : null;
  const post = readPosterior(posterior);

  let masterScore = 0;
  let totalWeight = 0;
  let weightedConfidence = 0;
  let maxTs = 0;
  const perZ: Record<string, number> = {};
  const effective: MasterDecision["effectiveWeights"] = [];
  const contributing: EnsembleDecision["contributing"] = [];

  for (const sig of signals) {
    if (!sig) continue;
    if (allowed && !allowed.has(sig.strategyId)) continue;
    if (sig.ts > maxTs) maxTs = sig.ts;

    const z = signalToZ(sig);
    perZ[sig.strategyId] = z;

    const cell = weights[sig.strategyId] ?? {};
    let combinedWeight = 0;
    for (const r of REGIMES) {
      // Default fallback: 1/K equal weight when no W cell is set.
      const w = cell[r] ?? 1;
      const wEff = post[r] * w;
      combinedWeight += wEff;
      effective.push({ strategyId: sig.strategyId, regime: r, weight: wEff });
    }
    masterScore += combinedWeight * z;
    totalWeight += Math.abs(combinedWeight);
    weightedConfidence += combinedWeight * sig.confidence;

    contributing.push({
      strategyId: sig.strategyId,
      side: sig.side,
      score: sig.score,
      confidence: sig.confidence,
      weight: combinedWeight,
      entryHint: sig.entryHint,
    });
  }

  // Normalize the score so a uniform-weight equivalence with the old
  // aggregator holds (per `aggregate()`'s normalizedScore = weightedScore/totalWeight).
  const normalized = totalWeight > 0 ? masterScore / totalWeight : 0;
  const confidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

  let side: Side = "flat";
  if (normalized >= longT) side = "long";
  else if (normalized <= -shortT) side = "short";

  return {
    ts: maxTs,
    side,
    score: normalized,
    masterScore: normalized,
    confidence,
    contributing,
    perStrategyZ: perZ,
    effectiveWeights: effective,
    posterior: post,
  };
}

/**
 * Helper for backwards compatibility: call `master()` with uniform
 * posterior + weights chosen to match a flat `EnsembleWeights` map. Used
 * by the equivalence test that proves `master()` ≡ `aggregate()` in the
 * uniform-posterior / equal-weight limit.
 */
export function flatWeightsFromMap(weights: Record<string, number>): MasterWeights {
  const out: MasterWeights = {};
  for (const [id, w] of Object.entries(weights)) {
    out[id] = { bull: w, range: w, bear: w };
  }
  return out;
}
