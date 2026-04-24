import type { EnsembleDecision, Side, StrategySignal } from "./types";

export interface EnsembleWeights {
  [strategyId: string]: number;
}

export interface EnsembleOptions {
  weights: EnsembleWeights;
  longThreshold?: number;  // sum must exceed this for a long decision
  shortThreshold?: number; // sum must be below -this for a short decision
}

const DEFAULTS = { longThreshold: 0.25, shortThreshold: 0.25 };

/**
 * Combines per-strategy signals into a single decision.
 *
 *  aggregate score      = Σ (weight * signal.score * signal.confidence)
 *  aggregate confidence = Σ (weight * signal.confidence) / Σ weight
 *
 * `flat` signals contribute zero to the score but still dilute weight so a
 * single confident strategy can't dominate when the rest say nothing.
 */
export function aggregate(
  signals: readonly (StrategySignal | null)[],
  opts: EnsembleOptions,
): EnsembleDecision {
  const longT = opts.longThreshold ?? DEFAULTS.longThreshold;
  const shortT = opts.shortThreshold ?? DEFAULTS.shortThreshold;

  let weightedScore = 0;
  let weightedConfidence = 0;
  let totalWeight = 0;
  let maxTs = 0;
  const contributing: EnsembleDecision["contributing"] = [];

  for (const sig of signals) {
    if (!sig) continue;
    const w = opts.weights[sig.strategyId] ?? 0;
    if (w <= 0) continue;
    if (sig.ts > maxTs) maxTs = sig.ts;
    totalWeight += w;
    const dirMult = sig.side === "long" ? 1 : sig.side === "short" ? -1 : 0;
    const contribution = w * sig.score * sig.confidence * (dirMult === 0 ? 0 : 1);
    weightedScore += contribution;
    weightedConfidence += w * sig.confidence;
    contributing.push({
      strategyId: sig.strategyId,
      side: sig.side,
      score: sig.score,
      confidence: sig.confidence,
      weight: w,
    });
  }

  if (totalWeight === 0) {
    return { ts: maxTs, side: "flat", score: 0, confidence: 0, contributing };
  }

  const normalizedScore = weightedScore / totalWeight;
  const normalizedConfidence = weightedConfidence / totalWeight;

  let side: Side = "flat";
  if (normalizedScore >= longT) side = "long";
  else if (normalizedScore <= -shortT) side = "short";

  return {
    ts: maxTs,
    side,
    score: normalizedScore,
    confidence: normalizedConfidence,
    contributing,
  };
}
