export type PipelineStageId =
  | "premarket_pull"
  | "claude_analysis"
  | "signal_crossref"
  | "universe_finalization"
  | "execution"
  | "regime_check"
  | "eod_review";

export interface PipelineStage {
  id: PipelineStageId;
  label: string;
  scheduledTime: string;
  status: "pending" | "active" | "completed" | "error";
  startedAt?: string;
  completedAt?: string;
  logs: string[];
}
