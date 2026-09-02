import { describe, expect, it } from "vitest";
import { InstrumentLocks, type OrderIntent, type OutcomeInstrument } from "@nbe-theta/execution-domain";
import { ExecutionCoordinator } from "../coordinator.js";
import { ClobSimulator } from "../venues/simulator.js";

/**
 * The v2 race regression. CLAUDE.md requires this test by name:
 *
 * > Regression tests for the coordinator MUST exercise the v2 race
 * > (multiple concurrent triggers racing an async venue call) against
 * > per-instrument locks and the CLOB simulator.
 *
 * The original incident: four close orders in one millisecond flipped a
 * position into a 57× leveraged runaway long that lost $29k on a 1.94%
 * drop. Root cause was four things together — sync check, async submit,
 * shared mutable state, and a mock broker with no buying-power
 * enforcement.
 *
 * These tests reproduce the *shape* of that: many triggers firing
 * concurrently at one instrument, against a simulator that consumes
 * depth and enforces buying power exactly as the venue would.
 */

const INSTRUMENT: OutcomeInstrument = {
  venue: "polymarket",
  conditionId: "0xcond",
  outcomeTokenId: "tok-1",
};

function intent(id: string, side: "BUY" | "SELL" = "BUY", qty = "100"): OrderIntent {
  return {
    clientIntentId: id,
    instrument: INSTRUMENT,
    side,
    quantity: qty,
    limitPrice: side === "BUY" ? "0.60" : "0.10",
    timeInForce: "FOK",
  };
}

function simWithBook(cash = 100_000, latencyMs = 1): ClobSimulator {
  const sim = new ClobSimulator({ startingCash: cash, latencyMs, feeRate: 0 });
  sim.setBook(
    INSTRUMENT,
    [{ price: "0.40", size: "100000" }],
    [{ price: "0.50", size: "100000" }],
  );
  return sim;
}

describe("v2 race: concurrent triggers on one instrument", () => {
  it("serialises four simultaneous DIFFERENT intents to exactly one submit", async () => {
    // The literal v2 shape: four triggers in the same tick, each with
    // its own intent id so idempotency alone cannot save us. Only the
    // per-instrument lock can, and only because it is taken
    // synchronously before any await.
    const sim = simWithBook();
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });

    const outcomes = await Promise.all([
      coord.dispatch(intent("a")),
      coord.dispatch(intent("b")),
      coord.dispatch(intent("c")),
      coord.dispatch(intent("d")),
    ]);

    const executed = outcomes.filter((o) => o.kind === "executed");
    const busy = outcomes.filter((o) => o.kind === "skipped" && o.reason === "instrument_busy");

    expect(executed).toHaveLength(1);
    expect(busy).toHaveLength(3);
    // The venue saw exactly one submit. This is the assertion that would
    // have failed in v2 — there it saw four.
    expect(sim.submitLog).toHaveLength(1);
    expect(sim.positionQty(INSTRUMENT)).toBe(100);
  });

  it("does not multiply the position when 20 triggers fire at once", async () => {
    const sim = simWithBook();
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => coord.dispatch(intent(`x${i}`))),
    );

    expect(sim.submitLog).toHaveLength(1);
    expect(sim.positionQty(INSTRUMENT)).toBe(100);
  });

  it("allows concurrent dispatch on DIFFERENT instruments", async () => {
    // The lock must be per-instrument. A global mutex — the v1 shape —
    // would serialise unrelated markets: slower, and no safer.
    const sim = simWithBook();
    const other: OutcomeInstrument = { ...INSTRUMENT, outcomeTokenId: "tok-2" };
    sim.setBook(other, [{ price: "0.40", size: "10000" }], [{ price: "0.50", size: "10000" }]);
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });

    const outcomes = await Promise.all([
      coord.dispatch(intent("one")),
      coord.dispatch({ ...intent("two"), instrument: other }),
    ]);

    expect(outcomes.every((o) => o.kind === "executed")).toBe(true);
    expect(sim.submitLog).toHaveLength(2);
  });

  it("releases the lock after each dispatch so the instrument stays tradable", async () => {
    const sim = simWithBook();
    const locks = new InstrumentLocks();
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim, locks });

    await coord.dispatch(intent("first"));
    expect(locks.size).toBe(0);

    const second = await coord.dispatch(intent("second"));
    expect(second.kind).toBe("executed");
  });

  it("releases the lock even when the venue throws", async () => {
    // Without the `finally` in withInstrumentLock, one thrown submit
    // would strand the instrument permanently.
    const sim = simWithBook();
    const locks = new InstrumentLocks();
    const exploding = {
      ...sim,
      submitIntent: async () => {
        throw new Error("venue exploded");
      },
    } as unknown as ClobSimulator;
    const coord = new ExecutionCoordinator({
      accountId: "sim-account",
      venue: exploding,
      locks,
    });

    await expect(coord.dispatch(intent("boom"))).rejects.toThrow("venue exploded");
    expect(locks.size).toBe(0);
  });
});

describe("buying power — the fourth ingredient of v2", () => {
  it("the simulator refuses an order it cannot fund", async () => {
    // A mock with no buying-power check makes the race invisible: four
    // oversized orders all 'succeed' and the suite stays green.
    const sim = new ClobSimulator({ startingCash: 10, feeRate: 0 });
    sim.setBook(INSTRUMENT, [{ price: "0.40", size: "1000" }], [{ price: "0.50", size: "1000" }]);

    const report = await sim.submitIntent(intent("too-big", "BUY", "1000"));
    expect(report.status).toBe("rejected");
    expect(report.reason).toBe("insufficient_buying_power");
    expect(sim.positionQty(INSTRUMENT)).toBe(0);
  });

  it("refuses a sell beyond inventory rather than opening a short", async () => {
    const sim = simWithBook();
    const report = await sim.submitIntent(intent("naked", "SELL", "50"));
    expect(report.status).toBe("rejected");
    expect(report.reason).toBe("insufficient_inventory");
    expect(sim.positionQty(INSTRUMENT)).toBe(0);
  });

  it("consumes depth so two orders cannot take the same liquidity", async () => {
    const sim = new ClobSimulator({ startingCash: 100_000, feeRate: 0 });
    sim.setBook(INSTRUMENT, [], [{ price: "0.50", size: "100" }]);

    const first = await sim.submitIntent(intent("first", "BUY", "100"));
    const second = await sim.submitIntent(intent("second", "BUY", "100"));

    expect(first.status).toBe("filled");
    // The book is empty now. A simulator that did not consume depth
    // would fill this too and hide the race entirely.
    expect(second.status).toBe("rejected");
  });
});

describe("idempotency", () => {
  it("a replayed intent id is not submitted twice", async () => {
    const sim = simWithBook();
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });

    const a = await coord.dispatch(intent("same-id"));
    const b = await coord.dispatch(intent("same-id"));

    expect(a.kind).toBe("executed");
    expect(b).toEqual({ kind: "skipped", reason: "duplicate_intent" });
    expect(sim.submitLog).toHaveLength(1);
  });

  it("survives a restart when prior intent ids are supplied", async () => {
    // Cross-process idempotency: a fresh coordinator seeded from the
    // outbox must not re-place what the previous one already sent.
    const sim = simWithBook();
    const coord = new ExecutionCoordinator({
      accountId: sim.accountId,
      venue: sim,
      seenIntents: new Set(["already-sent"]),
    });

    const outcome = await coord.dispatch(intent("already-sent"));
    expect(outcome).toEqual({ kind: "skipped", reason: "duplicate_intent" });
    expect(sim.submitLog).toHaveLength(0);
  });
});
