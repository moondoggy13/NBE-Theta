import type { MacroIndicator, MacroRegime, MacroSnapshot } from "./types";

/**
 * Classifies the macro regime from a set of FRED indicator values.
 *
 * Risk-on:  VIX < 18, positive yield curve, stable/falling rates
 * Risk-off: VIX > 25, inverted yield curve, rising rates
 * Neutral:  everything else
 */
export function classifyRegimeFromIndicators(indicators: MacroIndicator[]): MacroSnapshot {
  const byId = new Map(indicators.map((i) => [i.seriesId, i]));

  const vix = byId.get("VIXCLS")?.value ?? 20;
  const yieldSpread = byId.get("T10Y2Y")?.value ?? 0;
  const fedFunds = byId.get("FEDFUNDS")?.value ?? 5;
  const fedFundsPrev = byId.get("FEDFUNDS")?.previous ?? fedFunds;
  const unemployment = byId.get("UNRATE")?.value ?? 4;
  const sentiment = byId.get("UMCSENT")?.value ?? 65;

  let riskScore = 0; // positive = risk-on, negative = risk-off

  // VIX: low volatility = risk-on
  if (vix < 15) riskScore += 2;
  else if (vix < 18) riskScore += 1;
  else if (vix > 30) riskScore -= 2;
  else if (vix > 25) riskScore -= 1;

  // Yield curve: positive = healthy, inverted = recession risk
  if (yieldSpread > 0.5) riskScore += 2;
  else if (yieldSpread > 0) riskScore += 1;
  else if (yieldSpread < -0.5) riskScore -= 2;
  else if (yieldSpread < 0) riskScore -= 1;

  // Fed funds: falling = easing = risk-on
  if (fedFunds < fedFundsPrev) riskScore += 1;
  else if (fedFunds > fedFundsPrev) riskScore -= 1;

  // Unemployment: low = strong economy
  if (unemployment < 4.0) riskScore += 1;
  else if (unemployment > 5.0) riskScore -= 1;

  // Consumer sentiment: high = confidence
  if (sentiment > 75) riskScore += 1;
  else if (sentiment < 55) riskScore -= 1;

  let regime: MacroRegime;
  let economicModifier: number;
  let summary: string;

  if (riskScore >= 3) {
    regime = "risk_on";
    economicModifier = 3;
    summary = `Risk-on environment: VIX ${vix.toFixed(1)}, positive yield curve (${yieldSpread.toFixed(2)}), stable rates`;
  } else if (riskScore <= -2) {
    regime = "risk_off";
    economicModifier = -3;
    summary = `Risk-off environment: VIX ${vix.toFixed(1)}, yield curve ${yieldSpread.toFixed(2)}, elevated uncertainty`;
  } else {
    regime = "neutral";
    economicModifier = 0;
    summary = `Neutral macro environment: VIX ${vix.toFixed(1)}, yield curve ${yieldSpread.toFixed(2)}`;
  }

  return {
    regime,
    indicators,
    economicModifier,
    summary,
    fetchedAt: new Date().toISOString(),
  };
}
