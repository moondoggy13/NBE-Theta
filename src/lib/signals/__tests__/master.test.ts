import { describe, expect, it } from "vitest";
import { aggregate } from "../ensemble";
import { flatWeightsFromMap, master, signalToZ, uniformPosterior } from "../master";
import type { StrategySignal } from "../types";
import type { RegimePosterior } from "../../regime/types";

function sig(
  id: string,
  side: StrategySignal["side"],
  score: number,
  confidence: number,
): StrategySignal {
  return { strategyId: id, ts: 1, side, score, confidence, features: {} };
}

function posterior(bull: number, range: number, bear: number, ts = 1): RegimePosterior {
  // normalize for safety
  const s = bull + range + bear || 1;
  return {
    ts,
    probs: { bull: bull / s, range: range / s, bear: bear / s },
    dominant: bull >= range && bull >= bear ? "bull" : range >= bear ? "range" : "bear",
  };
}

describe("signalToZ adapter", () => {
  it("flat signals collapse to z=0", () => {
    expect(signalToZ(sig("a", "flat", 0.9, 0.9))).toBe(0);
  });
  it("clips at ±3", () => {
    expect(signalToZ(sig("a", "long", 5, 1))).toBe(3);
    expect(signalToZ(sig("a", "short", -5, 1))).toBe(-3);
  });
  it("scales linearly with confidence and absolute score", () => {
    expect(signalToZ(sig("a", "long", 0.5, 0.5))).toBeCloseTo(0.75, 6);
  });
});

describe("master signal", () => {
  it("decision equivalent to aggregate() under uniform posterior + equal weights (master threshold = 3× legacy)", () => {
    // master's normalized score is exactly 3× the old aggregate's normalized
    // score because signalToZ multiplies by 3 (score · conf · 3 vs score · conf).
    // We carry that through by defaulting master's threshold to 0.90 = 3 × 0.30.
    const cases = [
      [sig("a", "long", 0.8, 0.9), sig("b", "short", -0.6, 0.8)], // 2:1 disagree → both flat
      [sig("a", "long", 0.9, 0.9)],                                // single confident → both long
      [sig("a", "short", -0.9, 0.9)],                              // single bearish  → both short
    ];
    for (const sigs of cases) {
      const w: Record<string, number> = {};
      for (const s of sigs) w[s.strategyId] = 1;
      const oldResult = aggregate(sigs, { weights: w });
      const newResult = master(sigs, flatWeightsFromMap(w), null);
      expect(newResult.side).toBe(oldResult.side);
      // Master's continuous score should be ~3× the legacy normalized score.
      if (Math.abs(oldResult.score) > 1e-9) {
        expect(newResult.masterScore / oldResult.score).toBeCloseTo(3, 1);
      }
    }
  });

  it("regime conditioning routes weight to the dominant regime", () => {
    // Strategy A is bullish-biased, strategy B is bearish-biased. With a
    // bull posterior and W heavily favoring A in bull, master should agree
    // with A. With a bear posterior and W favoring B in bear, master
    // should flip to short.
    const sigs = [sig("a", "long", 0.9, 0.9), sig("b", "short", -0.9, 0.9)];
    const w = {
      a: { bull: 3, range: 1, bear: 0 },
      b: { bull: 0, range: 1, bear: 3 },
    };

    // Use a lower threshold for this test so the routing is detectable
    // (the regime conditioning effect doesn't always cross the default 0.9).
    const opts = { longThreshold: 0.3, shortThreshold: 0.3 };
    const bullDecision = master(sigs, w, posterior(0.9, 0.05, 0.05), opts);
    expect(bullDecision.side).toBe("long");

    const bearDecision = master(sigs, w, posterior(0.05, 0.05, 0.9), opts);
    expect(bearDecision.side).toBe("short");

    const rangeDecision = master(sigs, w, posterior(0.05, 0.9, 0.05), opts);
    // In range, weights are equal (1 each); zA(+) and zB(-) cancel → flat.
    expect(rangeDecision.side).toBe("flat");
  });

  it("missing posterior → uniform", () => {
    const sigs = [sig("a", "long", 0.9, 0.9)];
    const result = master(sigs, flatWeightsFromMap({ a: 1 }), null);
    expect(result.posterior.bull).toBeCloseTo(1 / 3, 6);
    expect(result.posterior.range).toBeCloseTo(1 / 3, 6);
    expect(result.posterior.bear).toBeCloseTo(1 / 3, 6);
  });

  it("uniformPosterior helper sums to 1", () => {
    const u = uniformPosterior();
    const s = u.bull + u.range + u.bear;
    expect(s).toBeCloseTo(1, 8);
  });

  it("strategyIds filter excludes other sleeves from aggregation", () => {
    const sigs = [sig("a", "long", 0.9, 0.9), sig("b", "short", -0.9, 0.9)];
    const w = { a: { bull: 1, range: 1, bear: 1 }, b: { bull: 1, range: 1, bear: 1 } };
    const onlyA = master(sigs, w, null, { strategyIds: ["a"], longThreshold: 0.3, shortThreshold: 0.3 });
    expect(onlyA.side).toBe("long");
    const onlyB = master(sigs, w, null, { strategyIds: ["b"], longThreshold: 0.3, shortThreshold: 0.3 });
    expect(onlyB.side).toBe("short");
  });
});
