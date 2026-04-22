export interface StrategyConfig {
  convictionThreshold: number;
  maxPositions: number;
  maxPositionSizePct: number;
  stopLossMinPct: number;
  stopLossMaxPct: number;
  killSwitchPct: number;
  pollingIntervalMs: number;
}

export interface APIConnection {
  name: string;
  provider: "alpaca" | "perplexity" | "unusual_whales" | "supabase" | "redis" | "economic_calendar" | "fred" | "anthropic";
  status: "connected" | "disconnected" | "error";
  lastPing?: string;
}
