import type { SubmitOrderBody } from "../protocol";

export interface FillReport {
  /** Set true only if the verifier confirmed the order in Webull's Orders panel. */
  filled: boolean;
  ts: number;
  price?: number;
  qty?: number;
  fee?: number;
  /** Free-form reason on reject / dry-run / verification miss. */
  reason?: string;
  /** Audit trail: every action the driver took, in order. */
  actions: DriverAction[];
}

export interface DriverAction {
  ts: number;
  /** Skill name, or "raw" for low-level mouse/keyboard. */
  skill: string;
  args?: unknown;
  /** Optional screenshot URL/path captured before this action. */
  screenshot?: string;
  /** Model's stated reason for this action; useful for postmortems. */
  reasoning?: string;
}

export interface DriverContext {
  /** When true the driver MUST NOT execute the final Submit click. */
  dryRun: boolean;
  /** Hard ceiling the driver re-checks just before Submit. */
  maxNotionalUsd: number;
  /** Optional pre-Submit human confirm (Promise<boolean>). */
  requireConfirm?: () => Promise<boolean>;
  /** Per-step timeout; the loop aborts cleanly if exceeded. */
  stepTimeoutMs: number;
  /** Total budget for the whole order. */
  totalTimeoutMs: number;
}

export interface CUADriver {
  readonly name: "claude" | "openai";
  runOrder(order: SubmitOrderBody, ctx: DriverContext): Promise<FillReport>;
}
