import { describe, expect, it } from "vitest";
import {
  assignTiers,
  computeFlows,
  type PositionRow,
  type WatchWeight,
} from "../smart-money";

const NOW = Date.parse("2026-08-01T12:00:00Z");

const W1 = "0x" + "a1".repeat(20);
const W2 = "0x" + "b2".repeat(20);
const W3 = "0x" + "c3".repeat(20);
const COND = "0x" + "11".repeat(32);

function pos(overrides: Partial<PositionRow>): PositionRow {
  return {
    wallet: W1,
    condition_id: COND,
    outcome_token_id: "1",
    outcome_name: "Yes",
    outcome_index: 0,
    size: 1000,
    avg_price: 0.4,
    cur_price: 0.45,
    initial_value: 400,
    current_value: 450,
    cash_pnl: 50,
    redeemable: false,
    title: "Will X happen?",
    slug: "will-x-happen",
    event_slug: "x",
    end_date: "2026-12-31T00:00:00Z",
    captured_at: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function weights(entries: Array<[string, number, WatchWeight["status"]]>): Map<string, WatchWeight> {
  return new Map(entries.map(([w, weight, status]) => [w, { weight, status }]));
}

describe("computeFlows", () => {
  it("aggregates one market's consensus with weighted entries", () => {
    const rows = computeFlows(
      [
        pos({ wallet: W1, avg_price: 0.4, initial_value: 400, current_value: 450 }),
        pos({
          wallet: W2,
          outcome_token_id: "1",
          avg_price: 0.3,
          initial_value: 1200,
          current_value: 1800,
          size: 4000,
        }),
      ],
      weights([
        [W1, 1, "watch"],
        [W2, 1, "copy"],
      ]),
      new Map([
        [`${W1}|${COND}`, NOW - 3_600_000],
        [`${W2}|${COND}`, NOW - 3_600_000],
      ]),
      new Map(),
      { nowMs: NOW },
    );

    expect(rows).toHaveLength(1);
    const f = rows[0];
    expect(f.dominant.outcome).toBe("Yes");
    expect(f.dominant.wallets).toBe(2);
    expect(f.dominant.usd).toBeCloseTo(2250);
    // Initial-value-weighted average entry: (0.4*400 + 0.3*1200) / 1600.
    expect(f.dominant.avgEntry).toBeCloseTo(0.325, 5);
    expect(f.opposing).toBeNull();
    expect(f.conviction).toBeGreaterThan(0);
    // Larger stakes list is sorted by dollars.
    expect(f.dominant.stakes[0].wallet).toBe(W2);
  });

  it("disagreement between tracked wallets cancels conviction", () => {
    const agree = computeFlows(
      [
        pos({ wallet: W1, initial_value: 1000 }),
        pos({ wallet: W2, initial_value: 1000 }),
      ],
      weights([
        [W1, 1, "watch"],
        [W2, 1, "watch"],
      ]),
      new Map(),
      new Map(),
      { nowMs: NOW },
    )[0];

    const disagree = computeFlows(
      [
        pos({ wallet: W1, initial_value: 1000 }),
        pos({
          wallet: W2,
          initial_value: 1000,
          outcome_name: "No",
          outcome_index: 1,
          outcome_token_id: "2",
          avg_price: 0.6,
          cur_price: 0.55,
        }),
      ],
      weights([
        [W1, 1, "watch"],
        [W2, 1, "watch"],
      ]),
      new Map(),
      new Map(),
      { nowMs: NOW },
    )[0];

    expect(disagree.conviction).toBeLessThan(agree.conviction);
    expect(disagree.conviction).toBeCloseTo(0, 5);
    expect(disagree.opposing).not.toBeNull();
  });

  it("recency decay ranks fresh accumulation above stale piles", () => {
    const freshMarket = "0x" + "22".repeat(32);
    const rows = computeFlows(
      [
        pos({ condition_id: COND, initial_value: 1000 }),
        pos({ condition_id: freshMarket, initial_value: 1000, title: "Fresh market" }),
      ],
      weights([[W1, 1, "watch"]]),
      new Map([
        [`${W1}|${COND}`, NOW - 14 * 86_400_000], // two weeks stale
        [`${W1}|${freshMarket}`, NOW - 3_600_000], // an hour old
      ]),
      new Map(),
      { nowMs: NOW },
    );
    expect(rows[0].conditionId).toBe(freshMarket);
    expect(rows[0].conviction).toBeGreaterThan(rows[1].conviction * 2);
  });

  it("operator weight scales contribution; muted and redeemable are excluded", () => {
    const boosted = computeFlows(
      [pos({ wallet: W1 })],
      weights([[W1, 3, "watch"]]),
      new Map(),
      new Map(),
      { nowMs: NOW },
    )[0];
    const baseline = computeFlows(
      [pos({ wallet: W1 })],
      weights([[W1, 1, "watch"]]),
      new Map(),
      new Map(),
      { nowMs: NOW },
    )[0];
    // Conviction is rounded to 2dp in the payload, so compare at 1dp.
    expect(boosted.conviction).toBeCloseTo(baseline.conviction * 3, 1);

    const excluded = computeFlows(
      [
        pos({ wallet: W1 }), // muted below
        pos({ wallet: W2, redeemable: true }),
        pos({ wallet: W3, size: 0 }),
      ],
      weights([
        [W1, 1, "mute"],
        [W2, 1, "watch"],
        [W3, 1, "watch"],
      ]),
      new Map(),
      new Map(),
      { nowMs: NOW },
    );
    expect(excluded).toHaveLength(0);
  });

  it("sub-linear dollar scaling: a 100× whale is not 100× the signal", () => {
    const whale = computeFlows(
      [pos({ wallet: W1, initial_value: 100_000 })],
      weights([[W1, 1, "watch"]]),
      new Map(),
      new Map(),
      { nowMs: NOW },
    )[0];
    const shrimp = computeFlows(
      [pos({ wallet: W1, initial_value: 1_000 })],
      weights([[W1, 1, "watch"]]),
      new Map(),
      new Map(),
      { nowMs: NOW },
    )[0];
    const ratio = whale.conviction / shrimp.conviction;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(2.5);
  });

  it("drops dust markets below minTotalUsd", () => {
    const rows = computeFlows(
      [pos({ current_value: 20, initial_value: 20 })],
      weights([[W1, 1, "watch"]]),
      new Map(),
      new Map(),
      { nowMs: NOW, minTotalUsd: 100 },
    );
    expect(rows).toHaveLength(0);
  });
});

describe("assignTiers", () => {
  it("splits 20/30/50 with stable tie-breaks", () => {
    const ranked = Array.from({ length: 10 }, (_, i) => ({
      wallet: `0x${String(i).padStart(40, "0")}`,
      quality: 100 - i * 10,
    }));
    const tiers = assignTiers(ranked);
    expect(tiers.get(ranked[0].wallet)).toBe("S");
    expect(tiers.get(ranked[1].wallet)).toBe("S");
    expect(tiers.get(ranked[2].wallet)).toBe("A");
    expect(tiers.get(ranked[4].wallet)).toBe("A");
    expect(tiers.get(ranked[5].wallet)).toBe("B");
    expect(tiers.get(ranked[9].wallet)).toBe("B");
  });

  it("a single wallet is S", () => {
    expect(assignTiers([{ wallet: "0xabc", quality: 0 }]).get("0xabc")).toBe("S");
  });
});
