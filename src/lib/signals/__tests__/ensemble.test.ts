import { describe, expect, it } from "vitest";
import { aggregate } from "../ensemble";
import type { StrategySignal } from "../types";

function sig(
  id: string,
  side: StrategySignal["side"],
  score: number,
  confidence: number,
): StrategySignal {
  return { strategyId: id, ts: 1, side, score, confidence, features: {} };
}

describe("aggregate", () => {
  it("is flat when no signals", () => {
    const d = aggregate([], { weights: {} });
    expect(d.side).toBe("flat");
    expect(d.score).toBe(0);
  });

  it("follows a single confident long signal", () => {
    const d = aggregate([sig("a", "long", 0.8, 0.9)], { weights: { a: 1 } });
    expect(d.side).toBe("long");
    expect(d.score).toBeGreaterThan(0.25);
  });

  it("is flat when two equal-weight signals disagree", () => {
    const d = aggregate(
      [sig("a", "long", 0.8, 0.9), sig("b", "short", -0.8, 0.9)],
      { weights: { a: 1, b: 1 } },
    );
    expect(d.side).toBe("flat");
    expect(Math.abs(d.score)).toBeLessThan(0.25);
  });

  it("weights bias the aggregate", () => {
    // a: w=3, score=0.9, conf=0.9 → 3*0.9*0.9 = 2.43
    // b: w=1, score=-0.9, conf=0.9 → 1*-0.9*0.9 = -0.81
    // weightedScore = 2.43 - 0.81 = 1.62; normalized = 1.62/4 = 0.405 > 0.4 → long
    const d = aggregate(
      [sig("a", "long", 0.9, 0.9), sig("b", "short", -0.9, 0.9)],
      { weights: { a: 3, b: 1 } },
    );
    expect(d.side).toBe("long");
  });

  it("a flat signal dilutes confidence without changing direction", () => {
    const d = aggregate(
      [sig("a", "long", 0.9, 0.9), sig("b", "flat", 0, 0.1)],
      { weights: { a: 1, b: 1 } },
    );
    expect(d.side).toBe("long");
    // confidence averaged between 0.9 and 0.1
    expect(d.confidence).toBeCloseTo(0.5, 2);
  });
});
