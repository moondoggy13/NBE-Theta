import { supabase } from "../client";
import type { SignalEvent } from "@/types/events";

export async function getRecentEvents(limit: number = 20): Promise<SignalEvent[]> {
  if (!supabase) return [];
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("signal_events")
    .select("*")
    .eq("run_date", today)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (!data) return [];

  return data.map((row) => ({
    id: row.id,
    ticker: row.ticker,
    type: row.layer as SignalEvent["type"],
    message: row.message,
    timestamp: new Date(row.occurred_at).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "America/New_York",
    }),
    occurredAt: row.occurred_at,
    impact: row.impact as SignalEvent["impact"],
  }));
}
