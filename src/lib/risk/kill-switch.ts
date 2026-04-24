import type { RiskPreset } from "./config";

export interface RiskState {
  killSwitchActive: boolean;
  autonomousExecution: boolean;
  dayStartEquity: number;
  dailyLossDollars: number;
  dayAnchorUtc: string;   // YYYY-MM-DD
}

export function currentUtcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Returns true if a new order should be rejected given the current state.
 * Reasons (in priority): killSwitchActive → daily-loss limit → autonomousExecution off.
 */
export function shouldBlock(cfg: RiskPreset, state: RiskState, equity: number): {
  blocked: boolean;
  reason?: string;
} {
  if (state.killSwitchActive) return { blocked: true, reason: "kill_switch_active" };
  const lossPct = state.dayStartEquity > 0 ? (state.dayStartEquity - equity) / state.dayStartEquity : 0;
  if (lossPct >= cfg.dailyStopPct) return { blocked: true, reason: "daily_stop_hit" };
  if (!state.autonomousExecution) return { blocked: true, reason: "autonomous_off" };
  return { blocked: false };
}

export function maybeRollDay(state: RiskState, equity: number, now = new Date()): RiskState {
  const today = currentUtcDay(now);
  if (state.dayAnchorUtc !== today) {
    return {
      ...state,
      dayAnchorUtc: today,
      dayStartEquity: equity,
      dailyLossDollars: 0,
    };
  }
  return state;
}
