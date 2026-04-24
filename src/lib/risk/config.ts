export interface RiskPreset {
  name: string;
  startEquity: number;
  perTradeRiskPct: number;
  dailyStopPct: number;
  maxPositions: number;
}

export const PRESETS: Record<"Conservative" | "Moderate" | "Aggressive", RiskPreset> = {
  Conservative: { name: "Conservative", startEquity: 500,    perTradeRiskPct: 0.005, dailyStopPct: 0.02, maxPositions: 1 },
  Moderate:     { name: "Moderate",     startEquity: 5_000,  perTradeRiskPct: 0.01,  dailyStopPct: 0.05, maxPositions: 1 },
  Aggressive:   { name: "Aggressive",   startEquity: 25_000, perTradeRiskPct: 0.02,  dailyStopPct: 0.10, maxPositions: 1 },
};

export function resolveRiskConfig(env: {
  RISK_PRESET: "Conservative" | "Moderate" | "Aggressive" | "Custom";
  RISK_START_EQUITY?: number;
  RISK_PER_TRADE_PCT?: number;
  RISK_DAILY_STOP_PCT?: number;
}): RiskPreset {
  const base =
    env.RISK_PRESET === "Custom" ? PRESETS.Aggressive : PRESETS[env.RISK_PRESET];
  return {
    name: env.RISK_PRESET,
    startEquity: env.RISK_START_EQUITY ?? base.startEquity,
    perTradeRiskPct: env.RISK_PER_TRADE_PCT ?? base.perTradeRiskPct,
    dailyStopPct: env.RISK_DAILY_STOP_PCT ?? base.dailyStopPct,
    maxPositions: base.maxPositions,
  };
}
