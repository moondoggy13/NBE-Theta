import type { RiskMetrics } from "@/types/risk";

export const mockRiskMetrics: RiskMetrics = {
  dailyPnlPercent: 0.72,
  killSwitchThreshold: -3,
  killSwitchTriggered: false,
  totalExposurePercent: 31.8,
  maxDrawdownPercent: -1.2,
  positionCount: 3,
  maxPositions: 5,
  positions: [
    {
      ticker: "NVDA",
      exposurePercent: 9.9,
      maxExposure: 2,
      distanceToStopPercent: 10.8,
      stopLossPercent: 6,
    },
    {
      ticker: "AMZN",
      exposurePercent: 9.8,
      maxExposure: 2,
      distanceToStopPercent: 8.8,
      stopLossPercent: 6,
    },
    {
      ticker: "META",
      exposurePercent: 11.6,
      maxExposure: 2,
      distanceToStopPercent: 5.2,
      stopLossPercent: 6,
    },
  ],
};
