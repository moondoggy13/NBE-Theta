import type { RiskPreset } from "./config";

export interface SizeInputs {
  equity: number;
  entry: number;
  stop: number;
  minQty?: number;   // Coinbase BTC-USD: 1e-6 typical
  qtyIncrement?: number;
}

/**
 * Position size in base-asset units given a fixed risk-per-trade budget.
 *
 *   qty = (equity * perTradeRiskPct) / |entry - stop|
 *
 * Returns 0 if the stop is invalid or the resulting qty falls below the
 * exchange's minimum size.
 */
export function positionSize(cfg: RiskPreset, input: SizeInputs): number {
  const { equity, entry, stop } = input;
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk === 0 || equity <= 0) return 0;
  let qty = (equity * cfg.perTradeRiskPct) / risk;
  const inc = input.qtyIncrement ?? 1e-6;
  qty = Math.floor(qty / inc) * inc;
  const min = input.minQty ?? inc;
  return qty >= min ? qty : 0;
}
