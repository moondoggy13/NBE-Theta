/**
 * Convex drawdown brake — multiplies position size by a reduction factor
 * that grows piecewise as drawdown deepens.
 *
 *   ρ(DD) = 1.0    if DD <= 5%
 *           0.5    if 5% < DD <= 10%
 *           0.25   if 10% < DD <= 20%
 *           0.0    if DD > 20%   (hard kill)
 *
 * DD is measured as a positive fraction from peak: DD = (peak - equity) / peak.
 * The 0.0 floor at DD > 20% is a circuit-breaker that complements the
 * 15% lifetime kill switch in the risk gate — even if the kill switch's
 * persisted state hasn't been read yet, sizing collapses to zero so no
 * new entries can fire.
 */

export interface DrawdownBrakeBand {
  /** Inclusive upper bound on drawdown fraction (e.g. 0.05 = 5%). */
  uptoDd: number;
  multiplier: number;
}

export const DEFAULT_DRAWDOWN_BANDS: readonly DrawdownBrakeBand[] = [
  { uptoDd: 0.05, multiplier: 1.0 },
  { uptoDd: 0.10, multiplier: 0.5 },
  { uptoDd: 0.20, multiplier: 0.25 },
  { uptoDd: Infinity, multiplier: 0.0 },
];

export function drawdownFraction(equity: number, peakEquity: number): number {
  if (!Number.isFinite(peakEquity) || peakEquity <= 0) return 0;
  if (equity >= peakEquity) return 0;
  return (peakEquity - equity) / peakEquity;
}

export function drawdownBrake(
  equity: number,
  peakEquity: number,
  bands: readonly DrawdownBrakeBand[] = DEFAULT_DRAWDOWN_BANDS,
): number {
  const dd = drawdownFraction(equity, peakEquity);
  for (const b of bands) {
    if (dd <= b.uptoDd) return b.multiplier;
  }
  return 0;
}
