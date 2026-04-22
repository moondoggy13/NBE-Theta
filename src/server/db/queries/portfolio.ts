import { supabase } from "../client";
import type { PortfolioSummary, Position } from "@/types/portfolio";

export async function getPortfolioSummary(): Promise<PortfolioSummary | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("portfolio_state")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (!data) return null;

  return {
    totalValue: Number(data.total_value),
    cashAvailable: Number(data.cash_available),
    dayPnlDollars: Number(data.day_pnl_dollars),
    dayPnlPercent: Number(data.day_pnl_percent),
    totalPnlDollars: Number(data.total_pnl_dollars),
    totalPnlPercent: Number(data.total_pnl_percent),
    positionCount: data.position_count,
    maxPositions: data.max_positions,
  };
}

export async function getPositions(): Promise<Position[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("positions")
    .select("*")
    .order("entered_at", { ascending: false });

  if (!data) return [];

  return data.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    shares: Number(row.shares),
    entryPrice: Number(row.entry_price),
    currentPrice: Number(row.current_price),
    stopLoss: Number(row.stop_loss),
    target: Number(row.target),
    pnlDollars: Number(row.pnl_dollars),
    pnlPercent: Number(row.pnl_percent),
    convictionAtEntry: row.conviction_at_entry,
    enteredAt: row.entered_at,
    status: row.status as Position["status"],
  }));
}
