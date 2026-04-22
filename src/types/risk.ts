export interface PositionRisk {
  ticker: string;
  exposurePercent: number;
  maxExposure: number;
  distanceToStopPercent: number;
  stopLossPercent: number;
}

export interface RiskMetrics {
  dailyPnlPercent: number;
  killSwitchThreshold: number;
  killSwitchTriggered: boolean;
  totalExposurePercent: number;
  maxDrawdownPercent: number;
  positions: PositionRisk[];
  positionCount: number;
  maxPositions: number;
}
