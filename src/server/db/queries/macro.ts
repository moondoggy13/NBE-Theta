import { supabase } from "../client";
import type { MacroIndicator } from "@/server/services/macro/types";

export async function getMacroIndicatorsForToday(): Promise<MacroIndicator[]> {
  if (!supabase) return [];

  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("macro_indicators")
    .select("*")
    .eq("run_date", today)
    .order("series_id");

  if (!data?.length) return [];

  return data.map((row) => ({
    seriesId: row.series_id,
    label: row.label,
    value: Number(row.value),
    previous: row.previous != null ? Number(row.previous) : null,
    changePct: row.change_pct != null ? Number(row.change_pct) : null,
    fetchedAt: row.fetched_at,
  }));
}
