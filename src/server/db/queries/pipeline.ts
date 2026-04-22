import { supabase } from "../client";
import type { PipelineStage } from "@/types/pipeline";
import { PIPELINE_SCHEDULE } from "@/lib/constants";

export async function getPipelineStagesForToday(): Promise<PipelineStage[]> {
  if (!supabase) return [];
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("pipeline_runs")
    .select("*")
    .eq("run_date", today);

  // Build the full 7-stage array, merging DB rows with schedule constants
  const rowMap = new Map((data ?? []).map((r) => [r.stage_id, r]));

  return PIPELINE_SCHEDULE.map((sched) => {
    const row = rowMap.get(sched.id);
    return {
      id: sched.id as PipelineStage["id"],
      label: sched.label,
      scheduledTime: sched.time,
      status: (row?.status ?? "pending") as PipelineStage["status"],
      startedAt: row?.started_at ?? undefined,
      completedAt: row?.completed_at ?? undefined,
      logs: row?.logs ?? [],
    };
  });
}
