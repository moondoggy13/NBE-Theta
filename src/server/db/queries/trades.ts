import { supabase } from "../client";
import type { Trade } from "@/types/portfolio";

export async function getTrades(): Promise<Trade[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("trades")
    .select("*")
    .order("exited_at", { ascending: false });

  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    ticker: row.ticker,
    side: row.side as Trade["side"],
    entryPrice: Number(row.entry_price),
    exitPrice: Number(row.exit_price),
    shares: Number(row.shares),
    pnlDollars: Number(row.pnl_dollars),
    pnlPercent: Number(row.pnl_percent),
    enteredAt: row.entered_at,
    exitedAt: row.exited_at,
    holdTimeMinutes: row.hold_time_minutes,
    convictionAtEntry: row.conviction_at_entry,
    exitReason: row.exit_reason as Trade["exitReason"],
  }));
}
