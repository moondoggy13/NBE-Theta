import type { EnsembleDecision, Side, StrategySignal } from "./types";

export interface EnsembleWeights {
  [strategyId: string]: number;
}

export interface EnsembleOptions {
  weights: EnsembleWeights;
  longThreshold?: number;  // sum must exceed this for a long decision
  shortThreshold?: number; // sum must be below -this for a short decision
}

// Live calibration after observing real BTC microstructure: the prior 0.25
// caused 318 round-trips in 53h (fee bleed bug). 0.4 was too high — the
// ensemble peaked at ~0.34 even when mean-rev-bb showed strong setups
// (score 0.83+) because momentum-ema diluted toward neutral. 0.3 lets
// genuine setups through while requireConsecutive (2) + cooldownMs (5min)
// in the ExecutionManager block the noise-flipping that originally caused
// the bleed.
const DEFAULTS = { longThreshold: 0.3, shortThreshold: 0.3 };

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
      entryHint: sig.entryHint,
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
