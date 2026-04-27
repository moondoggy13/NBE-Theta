import type { RiskPreset } from "./config";

export interface SizeInputs {
  equity: number;
  entry: number;
  stop: number;
  minQty?: number;        // Coinbase BTC-USD: 1e-6 typical
  qtyIncrement?: number;
  /**
   * Cap on notional exposure as a multiple of equity.
   * 1.0 = spot reality (no leverage). Default 1.0 prevents the implicit
   * 50x+ leverage that risk-based sizing creates when stops are tight
   * relative to asset price (e.g. $89 stop on $78k BTC ⇒ 5.6 BTC notional
   * = ~17.5x leverage on $25k equity, even with "2% risk per trade").
   */
  maxLeverage?: number;
}

/**
 * Position size in base-asset units.
 *
 * Two layers, the smaller wins:
 *   1. Risk-budget sizing:  qty_risk     = (equity * perTradeRiskPct) / |entry - stop|
 *   2. Notional cap:        qty_notional = (equity * maxLeverage) / entry
 *
 * Returns 0 if the stop is invalid or the resulting qty falls below the
 * exchange's minimum size.
 */
export function positionSize(cfg: RiskPreset, input: SizeInputs): number {
  const { equity, entry, stop } = input;
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk === 0 || equity <= 0 || entry <= 0) return 0;

  const riskBased = (equity * cfg.perTradeRiskPct) / risk;
  const leverage = input.maxLeverage ?? 1.0;
  const notionalCap = (equity * leverage) / entry;

  let qty = Math.min(riskBased, notionalCap);

  const inc = input.qtyIncrement ?? 1e-6;
  qty = Math.floor(qty / inc) * inc;
  const min = input.minQty ?? inc;
  return qty >= min ? qty : 0;
}
