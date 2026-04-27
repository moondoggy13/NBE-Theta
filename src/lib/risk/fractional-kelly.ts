/**
 * Master sizer — fuses fractional Kelly + vol targeting + drawdown brake +
 * master signal magnitude into a single qty.
 *
 *   N_t = κ · (σ_target / σ̂_t) · Equity · sign(S) · |S|^p · ρ(DD_t) / Price
 *
 * Where:
 *   κ           = Kelly fraction (default 0.25 = quarter-Kelly)
 *   σ_target    = annualized portfolio vol target (default 0.20)
 *   σ̂_t        = annualized realized vol of the asset
 *   S           = master signal score in [~-3, ~+3]
 *   p           = exponent (default 1.0 linear; 0.5 sub-linear)
 *   ρ(DD_t)     = drawdown brake multiplier
 *
 * The result is composed with the existing `positionSize()` notional cap
 * in `sizer.ts` — the master sizer produces a TARGET notional, the v3
 * sizer enforces the buying-power cap. We always take the smaller.
 */

import type { RiskPreset } from "./config";
import { drawdownBrake } from "./drawdown-brake";
import { volTargetMultiplier } from "./vol-targeting";

export interface MasterSizeInputs {
  equity: number;
  peakEquity: number;
  price: number;
  /** Master signal score, signed, typical range [-3, +3]. */
  masterScore: number;
  /** Annualized realized vol of the asset (e.g. from `EwmaVol.annualized()`). */
  sigmaRealized: number;
  /** Annualized portfolio vol target (default 0.20 = 20%). */
  sigmaTarget?: number;
  /** Kelly fraction (default 0.25). */
  kellyFraction?: number;
  /** Score exponent (default 1.0). */
  scoreExponent?: number;
  /** Maximum gross leverage (default 1.0 = spot). */
  maxLeverage?: number;
  /** Smallest qty increment (default 1e-6 = Coinbase BTC-USD). */
  qtyIncrement?: number;
  /** Minimum qty (defaults to qtyIncrement). */
  minQty?: number;
}

export interface MasterSizeResult {
  qty: number;
  side: "long" | "short" | "flat";
  /** Target USD notional before increment rounding. */
  targetNotional: number;
  /** Multiplier breakdown (for dashboard / logging). */
  components: {
    kelly: number;
    volTarget: number;
    score: number;
    brake: number;
    leverageCap: number;
  };
}

const DEFAULTS = {
  sigmaTarget: 0.20,
  kellyFraction: 0.25,
  scoreExponent: 1.0,
  maxLeverage: 1.0,
  qtyIncrement: 1e-6,
} as const;

/**
 * Compute the masters-blessed position size. Returns `flat` if any of:
 *   - score is too small to overcome the rounding to qtyIncrement
 *   - sigmaRealized cannot be inferred (≤ 0)
 *   - drawdown brake says zero
 *   - equity ≤ 0
 *
 * Notional is hard-capped at equity × maxLeverage (spot reality unless
 * the user opts into margin/perps with a higher leverage).
 */
export function masterSize(input: MasterSizeInputs): MasterSizeResult {
  const sigmaTarget = input.sigmaTarget ?? DEFAULTS.sigmaTarget;
  const kelly = input.kellyFraction ?? DEFAULTS.kellyFraction;
  const exponent = input.scoreExponent ?? DEFAULTS.scoreExponent;
  const maxLeverage = input.maxLeverage ?? DEFAULTS.maxLeverage;
  const inc = input.qtyIncrement ?? DEFAULTS.qtyIncrement;
  const min = input.minQty ?? inc;

  const flat: MasterSizeResult = {
    qty: 0,
    side: "flat",
    targetNotional: 0,
    components: { kelly, volTarget: 0, score: 0, brake: 0, leverageCap: maxLeverage },
  };

  if (input.equity <= 0 || input.price <= 0) return flat;

  const brake = drawdownBrake(input.equity, input.peakEquity);
  if (brake <= 0) return { ...flat, components: { ...flat.components, brake } };

  const volMult = volTargetMultiplier(sigmaTarget, input.sigmaRealized);
  if (volMult <= 0) return { ...flat, components: { ...flat.components, brake, volTarget: 0 } };

  const sign = input.masterScore > 0 ? 1 : input.masterScore < 0 ? -1 : 0;
  const magnitude = Math.pow(Math.abs(input.masterScore), exponent);
  if (sign === 0 || magnitude === 0)
    return { ...flat, components: { kelly, volTarget: volMult, score: 0, brake, leverageCap: maxLeverage } };

  // Target notional in USD before constraints.
  let targetNotional = kelly * volMult * input.equity * magnitude;
  // Cap at gross leverage.
  const cap = input.equity * maxLeverage;
  if (targetNotional > cap) targetNotional = cap;

  let qty = targetNotional / input.price;
  qty = Math.floor(qty / inc) * inc;
  if (qty < min) return { ...flat, components: { kelly, volTarget: volMult, score: magnitude, brake, leverageCap: maxLeverage } };

  return {
    qty,
    side: sign > 0 ? "long" : "short",
    targetNotional,
    components: {
      kelly,
      volTarget: volMult,
      score: magnitude,
      brake,
      leverageCap: maxLeverage,
    },
  };
}
