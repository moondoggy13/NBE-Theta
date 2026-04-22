import { supabase } from "../client";
import type { StockSignal } from "@/types/signals";

export async function getSignalsForToday(): Promise<StockSignal[]> {
  if (!supabase) return [];
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("signal_scores")
    .select("*")
    .eq("run_date", today)
    .order("conviction_score", { ascending: false });

  if (!data?.length) return [];

  return data.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    convictionScore: row.conviction_score,
    inUniverse: row.in_universe,
    sector: row.sector ?? "",
    marketCap: Number(row.market_cap ?? 0),
    avgVolume: Number(row.avg_volume ?? 0),
    currentPrice: Number(row.current_price ?? 0),
    catalyst: row.catalyst_text ?? "",
    layers: [
      { name: "catalyst" as const, score: row.catalyst_score, signals: row.catalyst_signals, dataSource: "Perplexity Finance", updatedAt: row.updated_at },
      { name: "technical" as const, score: row.technical_score, signals: row.technical_signals, dataSource: "Alpaca Market Data", updatedAt: row.updated_at },
      { name: "options_flow" as const, score: row.options_score, signals: row.options_signals, dataSource: "Unusual Whales", updatedAt: row.updated_at },
      { name: "sentiment" as const, score: row.sentiment_score, signals: row.sentiment_signals, dataSource: "Supabase pgvector / News", updatedAt: row.updated_at },
      { name: "economic" as const, score: row.economic_score, signals: row.economic_signals, dataSource: "Economic Calendar", updatedAt: row.updated_at },
    ],
  }));
}
