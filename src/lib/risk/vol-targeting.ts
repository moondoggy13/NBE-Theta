/**
 * Volatility targeting helpers.
 *
 * EWMA realized vol with λ = 0.94 (RiskMetrics convention; half-life ~ 20 bars).
 * Annualization assumes 24/7 crypto markets: 525 600 minutes / year.
 */

const MIN_PER_YEAR = 365 * 24 * 60; // 525 600

/**
 * Exponentially-weighted realized volatility, computed on a series of
 * arithmetic bar returns. Returns ANNUALIZED σ.
 *
 *   σ²_t = λ · σ²_{t-1} + (1-λ) · r²_t
 *   σ_annual = σ_bar · sqrt(MIN_PER_YEAR / barMinutes)
 *
 * Stateful version (`EwmaVol`) is preferred in the hot path; this batch
 * helper exists for backtests and tests.
 */
export function ewmaVolAnnualized(
  returns: readonly number[],
  lambda = 0.94,
  barMinutes = 1,
): number {
  if (returns.length === 0) return 0;
  let v = 0;
  for (const r of returns) {
    v = lambda * v + (1 - lambda) * r * r;
  }
  return Math.sqrt(v) * Math.sqrt(MIN_PER_YEAR / barMinutes);
}

export class EwmaVol {
  private v = 0;
  private nObs = 0;

  constructor(
    public readonly lambda = 0.94,
    public readonly barMinutes = 1,
  ) {}

  /** Push a bar return; returns the running annualized σ. */
  push(barReturn: number): number {
    if (!Number.isFinite(barReturn)) return this.annualized();
    this.v = this.lambda * this.v + (1 - this.lambda) * barReturn * barReturn;
    this.nObs += 1;
    return this.annualized();
  }

  /** Current annualized σ. */
  annualized(): number {
    return Math.sqrt(this.v) * Math.sqrt(MIN_PER_YEAR / this.barMinutes);
  }

  observations(): number {
    return this.nObs;
  }

  reset(): void {
    this.v = 0;
    this.nObs = 0;
  }
}

/**
 * Vol-targeted notional given equity, target portfolio σ, and the latest
 * realized σ̂. Returns the multiplier σ_target / σ̂; positions size
 * downstream as: notional = multiplier · equity · |master_score|^p · ρ_t.
 *
 * Floors realized vol at a small positive number to prevent absurd
 * sizes when σ̂ ≈ 0 (cold start, all-flat returns).
 */
export function volTargetMultiplier(
  sigmaTarget: number,
  sigmaRealized: number,
  cap = 5,
): number {
  if (sigmaTarget <= 0) return 0;
  const floor = Math.max(sigmaRealized, sigmaTarget / cap);
  return sigmaTarget / floor;
}
