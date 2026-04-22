export interface SignalEvent {
  id: string;
  ticker: string;
  type: "catalyst" | "technical" | "options_flow" | "sentiment" | "economic";
  message: string;
  timestamp: string;
  occurredAt: string;
  impact: "bullish" | "bearish" | "neutral";
}
