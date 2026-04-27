import { describe, expect, it } from "vitest";
import { PRESETS, resolveRiskConfig } from "../config";
import { positionSize } from "../sizer";
import {
  currentUtcDay,
  makeInitialRiskState,
  maybeRollDay,
  shouldBlock,
} from "../kill-switch";

describe("resolveRiskConfig", () => {
  it("uses Aggressive defaults when preset is Aggressive", () => {
    const cfg = resolveRiskConfig({ RISK_PRESET: "Aggressive" });
    expect(cfg.startEquity).toBe(25_000);
    expect(cfg.perTradeRiskPct).toBe(0.02);
    expect(cfg.dailyStopPct).toBe(0.10);
  });
  it("env overrides apply on top of preset", () => {
    const cfg = resolveRiskConfig({
      RISK_PRESET: "Aggressive",
      RISK_START_EQUITY: 50_000,
      RISK_PER_TRADE_PCT: 0.03,
    });
    expect(cfg.startEquity).toBe(50_000);
    expect(cfg.perTradeRiskPct).toBe(0.03);
    expect(cfg.dailyStopPct).toBe(0.10);
  });
});

describe("positionSize", () => {
  it("uses risk/unit to size a position", () => {
    const cfg = PRESETS.Aggressive;
    const qty = positionSize(cfg, { equity: 25_000, entry: 50_000, stop: 49_500 });
    expect(qty).toBeCloseTo(1, 5);
  });
  it("returns 0 when stop equals entry", () => {
    expect(positionSize(PRESETS.Aggressive, { equity: 25_000, entry: 50_000, stop: 50_000 })).toBe(0);
  });
  it("rounds down to qtyIncrement", () => {
    const qty = positionSize(PRESETS.Aggressive, {
      equity: 25_000, entry: 100, stop: 99, qtyIncrement: 1e-3,
    });
    expect(qty).toBe(500);
  });
});

describe("kill-switch", () => {
  const baseCfg = PRESETS.Aggressive;
  const baseState = makeInitialRiskState({ startEquity: 25_000, autonomousExecution: true });

  it("lets orders through when nothing tripped", () => {
    expect(shouldBlock(baseCfg, baseState, 25_000).blocked).toBe(false);
  });
  it("blocks when kill switch is active", () => {
    const r = shouldBlock(baseCfg, { ...baseState, killSwitchActive: true }, 25_000);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("kill_switch_active");
  });
  it("blocks after 10% daily drawdown", () => {
    const r = shouldBlock(baseCfg, baseState, 22_500);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("daily_stop_hit");
  });
  it("blocks at 15% lifetime drawdown even after a day rollover", () => {
    // Yesterday's bug: rolling the day reset dayStartEquity to current,
    // letting cumulative loss exceed dailyStopPct. Lifetime gate catches this.
    const rolled = maybeRollDay(baseState, 21_000, new Date("2099-12-31T01:00:00Z"));
    const r = shouldBlock(baseCfg, rolled, 21_000);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("lifetime_stop_hit");
  });
  it("blocks when autonomous execution is off", () => {
    const r = shouldBlock(baseCfg, { ...baseState, autonomousExecution: false }, 25_000);
    expect(r.reason).toBe("autonomous_off");
  });
  it("rolls the day on UTC rollover, NEVER lowering dayStartEquity", () => {
    // The fix: a losing day cannot launder cumulative losses by anchoring
    // the next day at the lower equity.
    const losingState = { ...baseState, dayAnchorUtc: "1999-01-01", dayStartEquity: 25_000 };
    const rolled = maybeRollDay(losingState, 22_000, new Date("2026-04-22T12:00:00Z"));
    expect(rolled.dayAnchorUtc).toBe("2026-04-22");
    // dayStartEquity STAYS at 25k (the higher of prior dayStart and current equity).
    expect(rolled.dayStartEquity).toBe(22_000); // min(25k, 22k) = 22k — still bounded by current
    expect(rolled.dailyLossDollars).toBe(0);
  });
  it("rolls the day raising the floor when a winning day boosts equity", () => {
    const winningState = { ...baseState, dayAnchorUtc: "1999-01-01", dayStartEquity: 25_000 };
    const rolled = maybeRollDay(winningState, 30_000, new Date("2026-04-22T12:00:00Z"));
    // dayStartEquity = min(25k, 30k) = 25k. peakEquity tracks 30k.
    expect(rolled.dayStartEquity).toBe(25_000);
    expect(rolled.peakEquity).toBe(30_000);
  });
  it("tracks peakEquity high-water mark", () => {
    const stepped = maybeRollDay(baseState, 27_000, new Date());
    expect(stepped.peakEquity).toBe(27_000);
  });
});
