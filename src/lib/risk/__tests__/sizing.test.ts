import { describe, expect, it } from "vitest";
import { drawdownBrake, drawdownFraction } from "../drawdown-brake";
import { masterSize } from "../fractional-kelly";
import { EwmaVol, ewmaVolAnnualized, volTargetMultiplier } from "../vol-targeting";

describe("EwmaVol", () => {
  it("annualizes constant |r| returns to |r| × sqrt(525600)", () => {
    // EWMA of r² for constant r=0.001 converges to (1-λ) Σ λ^k r² = r².
    // So σ_bar = |r| = 0.001 and σ_annual = 0.001 · sqrt(525_600) ≈ 0.725.
    const v = new EwmaVol(0.94, 1);
    for (let i = 0; i < 200; i++) v.push(0.001);
    const expected = 0.001 * Math.sqrt(365 * 24 * 60);
    expect(v.annualized()).toBeCloseTo(expected, 3);
  });
  it("returns 0 before any observations", () => {
    const v = new EwmaVol(0.94, 1);
    expect(v.annualized()).toBe(0);
  });
  it("matches batch helper on the same input", () => {
    const returns = [0.005, -0.003, 0.002, -0.001, 0.004, -0.002, 0.003, -0.004];
    const v = new EwmaVol(0.94, 1);
    for (const r of returns) v.push(r);
    expect(v.annualized()).toBeCloseTo(ewmaVolAnnualized(returns, 0.94, 1), 8);
  });
});

describe("volTargetMultiplier", () => {
  it("returns σ_target / σ̂ in normal regime", () => {
    expect(volTargetMultiplier(0.20, 0.40)).toBeCloseTo(0.5, 6);
    expect(volTargetMultiplier(0.20, 0.10)).toBeCloseTo(2.0, 6);
  });
  it("caps multiplier when σ̂ approaches 0", () => {
    // With cap=5, σ̂ < σ_target/5 = 0.04 should clamp to 5x.
    expect(volTargetMultiplier(0.20, 0.001, 5)).toBeCloseTo(5, 6);
  });
  it("returns 0 if σ_target ≤ 0", () => {
    expect(volTargetMultiplier(0, 0.5)).toBe(0);
  });
});

describe("drawdownBrake", () => {
  it("full size when at peak (no drawdown)", () => {
    expect(drawdownBrake(25_000, 25_000)).toBe(1.0);
  });
  it("halves at -7% drawdown", () => {
    expect(drawdownFraction(23_250, 25_000)).toBeCloseTo(0.07, 6);
    expect(drawdownBrake(23_250, 25_000)).toBe(0.5);
  });
  it("quarters at -15% drawdown", () => {
    expect(drawdownBrake(21_250, 25_000)).toBe(0.25);
  });
  it("hard zero at >-20% drawdown", () => {
    expect(drawdownBrake(19_999, 25_000)).toBe(0.0);
  });
  it("treats invalid peak as no drawdown", () => {
    expect(drawdownBrake(20_000, 0)).toBe(1.0);
    expect(drawdownBrake(20_000, NaN)).toBe(1.0);
  });
});

describe("masterSize", () => {
  const baseline = {
    equity: 25_000,
    peakEquity: 25_000,
    price: 80_000,
    sigmaRealized: 0.40,
    sigmaTarget: 0.20,
    kellyFraction: 0.25,
    maxLeverage: 1.0,
    qtyIncrement: 1e-6,
  } as const;

  it("returns flat when masterScore is 0", () => {
    const r = masterSize({ ...baseline, masterScore: 0 });
    expect(r.side).toBe("flat");
    expect(r.qty).toBe(0);
  });
  it("scales linearly with masterScore (default exponent = 1)", () => {
    const a = masterSize({ ...baseline, masterScore: 0.5 });
    const b = masterSize({ ...baseline, masterScore: 1.0 });
    expect(b.qty).toBeGreaterThan(a.qty);
    expect(b.qty / a.qty).toBeCloseTo(2, 1);
  });
  it("respects 1.0× notional cap (spot)", () => {
    // Master score = 5 (extreme) — score factor pushes notional huge.
    // With volTarget = 0.5 and kelly = 0.25 and score = 5, raw notional
    // is 0.25 · 0.5 · 25k · 5 = $15,625. Below the $25k cap, so cap
    // doesn't bind here. Increase score to test cap.
    const r = masterSize({ ...baseline, masterScore: 50, sigmaRealized: 0.10 });
    // raw notional = 0.25 · 2 · 25k · 50 = $625,000 → capped to $25k.
    expect(r.targetNotional).toBeLessThanOrEqual(25_000 + 1e-6);
  });
  it("returns flat when drawdown brake is 0 (>20% DD)", () => {
    const r = masterSize({ ...baseline, equity: 19_000, masterScore: 1 });
    expect(r.side).toBe("flat");
    expect(r.qty).toBe(0);
    expect(r.components.brake).toBe(0);
  });
  it("halves notional when σ̂ doubles", () => {
    const lowVol = masterSize({ ...baseline, masterScore: 1, sigmaRealized: 0.20 });
    const highVol = masterSize({ ...baseline, masterScore: 1, sigmaRealized: 0.40 });
    expect(lowVol.targetNotional).toBeCloseTo(highVol.targetNotional * 2, 1);
  });
  it("flips side on negative score", () => {
    const long = masterSize({ ...baseline, masterScore: 1 });
    const short = masterSize({ ...baseline, masterScore: -1 });
    expect(long.side).toBe("long");
    expect(short.side).toBe("short");
    expect(long.qty).toBeCloseTo(short.qty, 8);
  });
});
