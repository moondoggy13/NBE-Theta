import type { RiskPreset } from "./config";

export interface RiskState {
  killSwitchActive: boolean;
  autonomousExecution: boolean;
  /** Equity at worker bootstrap. NEVER reset by daily rollover —
   *  it's the anchor for the lifetime drawdown gate. */
  lifetimeStartEquity: number;
  /** Maximum equity ever observed since worker bootstrap. */
  peakEquity: number;
  dayStartEquity: number;
  dailyLossDollars: number;
  dayAnchorUtc: string;       // YYYY-MM-DD
  /** Lifetime drawdown limit (fraction of lifetimeStartEquity). */
  lifetimeStopPct: number;    // e.g. 0.15 = -15% kills permanently
}

export function currentUtcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function makeInitialRiskState(opts: {
  startEquity: number;
  autonomousExecution: boolean;
  lifetimeStopPct?: number;
  now?: Date;
}): RiskState {
  return {
    killSwitchActive: false,
    autonomousExecution: opts.autonomousExecution,
    lifetimeStartEquity: opts.startEquity,
    peakEquity: opts.startEquity,
    dayStartEquity: opts.startEquity,
    dailyLossDollars: 0,
    dayAnchorUtc: currentUtcDay(opts.now),
    lifetimeStopPct: opts.lifetimeStopPct ?? 0.15,
  };
}

/**
 * Returns true if a new ENTRY order should be rejected.
 * Reasons in priority order:
 *   1. killSwitchActive (manual or persisted)
 *   2. autonomousExecution off (manual safe mode)
 *   3. lifetime drawdown breached (stops cumulative bleed across UTC days)
 *   4. daily drawdown breached (today's loss > preset.dailyStopPct of dayStartEquity)
 *
 * NOTE: this gate applies only to entries; closing existing positions is
 * always allowed by ExecutionManager regardless of these gates, so we never
 * leave a position stranded at the kill threshold.
 */
export function shouldBlock(cfg: RiskPreset, state: RiskState, equity: number): {
  blocked: boolean;
  reason?: string;
} {
  if (state.killSwitchActive) return { blocked: true, reason: "kill_switch_active" };
  if (!state.autonomousExecution) return { blocked: true, reason: "autonomous_off" };

  const lifetimeLossPct = state.lifetimeStartEquity > 0
    ? (state.lifetimeStartEquity - equity) / state.lifetimeStartEquity
    : 0;
  if (lifetimeLossPct >= state.lifetimeStopPct) {
    return { blocked: true, reason: "lifetime_stop_hit" };
  }

  const lossPct = state.dayStartEquity > 0
    ? (state.dayStartEquity - equity) / state.dayStartEquity
    : 0;
  if (lossPct >= cfg.dailyStopPct) return { blocked: true, reason: "daily_stop_hit" };

  return { blocked: false };
}

/**
 * Updates state on each decision tick: refreshes peakEquity + dailyLossDollars,
 * and rolls the UTC day anchor at midnight.
 *
 * IMPORTANT: rolling the day no longer resets `dayStartEquity` to the current
 * equity (the prior bug: it laundered cumulative losses by anchoring at the
 * lower equity each day, allowing >dailyStopPct% loss to accumulate). Instead,
 * the new day's start equity is set to the CURRENT equity capped above by the
 * peak equity — i.e., good days raise the floor, bad days don't lower it.
 *
 * The lifetime gate still catches genuine cumulative drawdown.
 */
export function maybeRollDay(state: RiskState, equity: number, now = new Date()): RiskState {
  const today = currentUtcDay(now);
  const peakEquity = Math.max(state.peakEquity, equity);
  const dailyLoss = Math.max(0, state.dayStartEquity - equity);

  if (state.dayAnchorUtc === today) {
    return { ...state, peakEquity, dailyLossDollars: dailyLoss };
  }
  // New UTC day: anchor day-equity at min(currentEquity, prior dayStart). This
  // means winning days raise the floor; losing days don't pretend they didn't
  // happen.
  const newDayStart = Math.min(state.dayStartEquity, equity);
  return {
    ...state,
    peakEquity,
    dayAnchorUtc: today,
    dayStartEquity: newDayStart,
    dailyLossDollars: 0,
  };
}
