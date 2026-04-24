import { describe, expect, it } from "vitest";
import { PRESETS, resolveRiskConfig } from "../config";
import { positionSize } from "../sizer";
import { shouldBlock, maybeRollDay, currentUtcDay } from "../kill-switch";

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
    // risk $500 / $500 per unit = 1 BTC; increment 1e-6
    expect(qty).toBeCloseTo(1, 5);
  });
  it("returns 0 when stop equals entry", () => {
    expect(positionSize(PRESETS.Aggressive, { equity: 25_000, entry: 50_000, stop: 50_000 })).toBe(0);
  });
  it("rounds down to qtyIncrement", () => {
    const qty = positionSize(PRESETS.Aggressive, {
      equity: 25_000, entry: 100, stop: 99, qtyIncrement: 1e-3,
    });
    // risk $500 / $1 per unit = 500 units
    expect(qty).toBe(500);
  });
});

describe("kill-switch", () => {
  const baseCfg = PRESETS.Aggressive;
  const baseState = {
    killSwitchActive: false,
    autonomousExecution: true,
    dayStartEquity: 25_000,
    dailyLossDollars: 0,
    dayAnchorUtc: currentUtcDay(),
  };

  it("lets orders through when nothing tripped", () => {
    expect(shouldBlock(baseCfg, baseState, 25_000).blocked).toBe(false);
  });
  it("blocks when kill switch is active", () => {
    const r = shouldBlock(baseCfg, { ...baseState, killSwitchActive: true }, 25_000);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("kill_switch_active");
  });
  it("blocks after 10% drawdown", () => {
    const r = shouldBlock(baseCfg, baseState, 22_500);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("daily_stop_hit");
  });
  it("blocks when autonomous execution is off", () => {
    const r = shouldBlock(baseCfg, { ...baseState, autonomousExecution: false }, 25_000);
    expect(r.reason).toBe("autonomous_off");
  });
  it("rolls the day on UTC rollover", () => {
    const rolled = maybeRollDay(
      { ...baseState, dayAnchorUtc: "1999-01-01", dayStartEquity: 10_000, dailyLossDollars: 50 },
      22_000,
      new Date("2026-04-22T12:00:00Z"),
    );
    expect(rolled.dayAnchorUtc).toBe("2026-04-22");
    expect(rolled.dayStartEquity).toBe(22_000);
    expect(rolled.dailyLossDollars).toBe(0);
  });
});
