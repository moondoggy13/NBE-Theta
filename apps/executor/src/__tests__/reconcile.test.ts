import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrderIntent, OutcomeInstrument } from "@nbe-theta/execution-domain";
import { ExecutionCoordinator } from "../coordinator.js";
import { LiveGateError, assertLiveAllowed, readLiveGate } from "../config.js";
import { backoffSeconds, isRedispatchable } from "../outbox.js";
import { ClobSimulator } from "../venues/simulator.js";
import { PolymarketClobVenue, type ClobSigningClient } from "../venues/polymarket.js";

const INSTRUMENT: OutcomeInstrument = {
  venue: "polymarket",
  conditionId: "0xcond",
  outcomeTokenId: "tok-1",
};

function intent(id: string): OrderIntent {
  return {
    clientIntentId: id,
    instrument: INSTRUMENT,
    side: "BUY",
    quantity: "100",
    limitPrice: "0.60",
    timeInForce: "FOK",
  };
}

describe("order uncertainty triggers reconciliation, never a retry", () => {
  it("an ambiguous submit does not resubmit", async () => {
    // The rule from AGENTS.md's truth hierarchy. A timeout means an
    // order MAY be resting on the venue; retrying doubles exposure.
    const sim = new ClobSimulator({ ambiguousSubmits: 1, feeRate: 0 });
    sim.setBook(INSTRUMENT, [], [{ price: "0.50", size: "1000" }]);
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });

    const outcome = await coord.dispatch(intent("ambiguous"));

    expect(outcome.kind).toBe("reconciled");
    // Exactly one submit reached the venue, despite the unknown outcome.
    expect(sim.submitLog).toHaveLength(1);
  });

  it("recovers the true outcome from venue fills when the ack was lost", async () => {
    // The submit "times out" but the venue really did fill it. Local
    // state says unknown; the venue's own fills say otherwise, and the
    // venue outranks us.
    const sim = new ClobSimulator({ feeRate: 0 });
    sim.setBook(INSTRUMENT, [], [{ price: "0.50", size: "1000" }]);
    await sim.submitIntent(intent("already-filled"));

    const lossy = Object.create(sim) as ClobSimulator;
    Object.defineProperty(lossy, "submitIntent", {
      value: async (i: OrderIntent) => ({
        clientIntentId: i.clientIntentId,
        venueOrderId: null,
        status: "unknown" as const,
        filledQuantity: "0",
        avgPrice: null,
        feesPaid: "0",
        reason: "timeout",
        observedAt: new Date().toISOString(),
      }),
    });

    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: lossy });
    const outcome = await coord.dispatch(intent("recover-me"));

    expect(outcome.kind).toBe("reconciled");
    if (outcome.kind === "reconciled") {
      expect(outcome.recovered).toBe(true);
      expect(outcome.report.status).toBe("filled");
      expect(Number(outcome.report.filledQuantity)).toBeGreaterThan(0);
    }
  });

  it("reports not-recovered when the venue genuinely has nothing", async () => {
    // Distinguishing "we cannot find it" from "it filled" matters: the
    // first may be safe to retry later, the second never is. Collapsing
    // them is how a duplicate order gets placed.
    const sim = new ClobSimulator({ ambiguousSubmits: 1, feeRate: 0 });
    sim.setBook(INSTRUMENT, [], [{ price: "0.50", size: "1000" }]);
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });

    const outcome = await coord.dispatch(intent("nothing-there"));
    expect(outcome.kind).toBe("reconciled");
    if (outcome.kind === "reconciled") expect(outcome.recovered).toBe(false);
  });

  it("an intent in reconciliation_break is never re-dispatched", () => {
    expect(isRedispatchable("reconciliation_break")).toBe(false);
    expect(isRedispatchable("filled")).toBe(false);
    expect(isRedispatchable("ready")).toBe(true);
  });

  it("backoff grows exponentially and its ceiling is actually reachable", () => {
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(4)).toBe(16);
    // The ceiling must bind. An earlier version capped the exponent too,
    // which made this 256 and the stated 300s ceiling dead code.
    expect(backoffSeconds(100)).toBe(300);
    expect(backoffSeconds(9)).toBe(300);
    expect(backoffSeconds(8)).toBe(256);
  });
});

describe("emergency state machine", () => {
  function coordWith(state: Parameters<ExecutionCoordinator["setRunState"]>[0]) {
    const sim = new ClobSimulator({ feeRate: 0 });
    sim.setBook(INSTRUMENT, [{ price: "0.40", size: "1000" }], [{ price: "0.50", size: "1000" }]);
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });
    coord.setRunState(state);
    return { sim, coord };
  }

  it("halted blocks every dispatch", async () => {
    const { sim, coord } = coordWith("halted");
    const outcome = await coord.dispatch(intent("blocked"));
    expect(outcome).toEqual({ kind: "skipped", reason: "halted" });
    expect(sim.submitLog).toHaveLength(0);
  });

  it("pause_new_entries blocks buys but not sells", async () => {
    const { sim, coord } = coordWith("pause_new_entries");
    await sim.submitIntent({ ...intent("seed"), side: "BUY" });

    const buy = await coord.dispatch(intent("new-entry"));
    expect(buy).toEqual({ kind: "skipped", reason: "entries_paused" });

    const sell = await coord.dispatch({ ...intent("exit"), side: "SELL", limitPrice: "0.10" });
    expect(sell.kind).toBe("executed");
  });

  it("a risk stop does not liquidate", async () => {
    // The subtle, important one. Forced selling on a paper loss realises
    // it at the worst available price in the thinnest book. Halting
    // stops dispatch and nothing else; flatten is a separate, explicit
    // operator action.
    const sim = new ClobSimulator({ feeRate: 0 });
    sim.setBook(INSTRUMENT, [{ price: "0.40", size: "1000" }], [{ price: "0.50", size: "1000" }]);
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });
    await coord.dispatch(intent("open-a-position"));
    const before = sim.positionQty(INSTRUMENT);
    expect(before).toBeGreaterThan(0);

    coord.setRunState("halted");

    // Position untouched. Nothing was sold by the state change itself.
    expect(sim.positionQty(INSTRUMENT)).toBe(before);
    expect(sim.submitLog).toHaveLength(1);
  });

  it("flatten produces bounded exit intents, never unbounded ones", async () => {
    const sim = new ClobSimulator({ feeRate: 0 });
    sim.setBook(INSTRUMENT, [{ price: "0.40", size: "1000" }], [{ price: "0.50", size: "1000" }]);
    const coord = new ExecutionCoordinator({ accountId: sim.accountId, venue: sim });
    await coord.dispatch(intent("position"));

    const exits = await coord.flatten();
    expect(exits).toHaveLength(1);
    // "Get me out at any price" in a thin book turns a 3c exit into a
    // 0.1c one. Even the emergency path carries a limit.
    expect(exits[0]?.limitPrice).toBeDefined();
    expect(exits[0]?.side).toBe("SELL");
  });
});

describe("the three-flag live gate", () => {
  const KEYS = ["EXECUTION_PROVIDER", "POLYMARKET_LIVE", "CONFIRM_LIVE"] as const;
  const original: Record<string, string | undefined> = {};
  const env = process.env as Record<string, string | undefined>;
  for (const k of KEYS) original[k] = env[k];

  beforeEach(() => {
    for (const k of KEYS) delete env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete env[k];
      else env[k] = original[k];
    }
  });

  const stubClient = {} as ClobSigningClient;

  it("refuses to construct the live venue with no flags", () => {
    expect(() => new PolymarketClobVenue(stubClient, "acct", {})).toThrow(LiveGateError);
  });

  it("refuses with only two of three", () => {
    const partial = { EXECUTION_PROVIDER: "polymarket-clob", POLYMARKET_LIVE: "true" };
    expect(() => new PolymarketClobVenue(stubClient, "acct", partial)).toThrow(LiveGateError);
    expect(readLiveGate(partial).missing).toEqual(["CONFIRM_LIVE=YES"]);
  });

  it("constructs only with all three", () => {
    const all = {
      EXECUTION_PROVIDER: "polymarket-clob",
      POLYMARKET_LIVE: "true",
      CONFIRM_LIVE: "YES",
    };
    expect(() => new PolymarketClobVenue(stubClient, "acct", all)).not.toThrow();
    expect(assertLiveAllowed(all).satisfied).toBe(true);
  });

  it("names exactly what is missing", () => {
    expect(readLiveGate({}).missing).toEqual([
      "EXECUTION_PROVIDER=polymarket-clob",
      "POLYMARKET_LIVE=true",
      "CONFIRM_LIVE=YES",
    ]);
  });

  it("the default environment is not live", () => {
    // CI never sets these (AGENTS.md). This asserts the default rather
    // than trusting it.
    expect(readLiveGate({}).satisfied).toBe(false);
  });
});
