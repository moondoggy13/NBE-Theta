export type MarketPhase = "pre-market" | "open" | "after-hours" | "closed";

export interface MarketStatus {
  phase: MarketPhase;
  nextEvent: string;
  nextEventTime: string;
}

export interface PriceQuote {
  ticker: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: string;
}
