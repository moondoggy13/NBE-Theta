export interface Position {
  ticker: string;
  name: string;
  shares: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  target: number;
  pnlDollars: number;
  pnlPercent: number;
  convictionAtEntry: number;
  enteredAt: string;
  status: "active" | "watching" | "exiting";
}

export interface PortfolioSummary {
  totalValue: number;
  cashAvailable: number;
  dayPnlDollars: number;
  dayPnlPercent: number;
  totalPnlDollars: number;
  totalPnlPercent: number;
  positionCount: number;
  maxPositions: number;
}

export interface Trade {
  id: string;
  ticker: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnlDollars: number;
  pnlPercent: number;
  enteredAt: string;
  exitedAt: string;
  holdTimeMinutes: number;
  convictionAtEntry: number;
  exitReason: "target" | "stop_loss" | "manual" | "eod";
}
