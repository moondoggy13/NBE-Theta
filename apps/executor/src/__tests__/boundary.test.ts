import { describe, expect, it } from "vitest";
import { PayloadError, parseIntentPayload } from "../boundary.js";

/**
 * The wire/domain boundary.
 *
 * PR 15 gave the outbox a producer that writes the payload defined by
 * `packages/contracts`. The executor consumes `OrderIntent` from
 * `packages/execution-domain`, which is hand-written and **shares not
 * one field name with it**: `intent_id` vs `clientIntentId`,
 * `limit_price` vs `limitPrice`, `instrument.condition_id` vs
 * `instrument.conditionId`, and so on.
 *
 * Reading a produced payload directly as a domain intent yields
 * `undefined` for every field — including quantity and price. It had
 * not bitten only because nothing wires claim to dispatch yet.
 *
 * The first test is therefore the one that matters: a payload shaped
 * exactly as the generated contract describes must come out the other
 * side fully populated.
 */

const ACCOUNT = "0xaccount";

/** A payload in the shape `packages/contracts/generated/ts` describes. */
function wirePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1",
    intent_id: "11111111-1111-4111-8111-111111111111",
    account_id: ACCOUNT,
    venue: "polymarket",
    instrument: {
      venue: "polymarket",
      condition_id: "0xcond",
      outcome_token_id: "tok-1",
    },
    side: "BUY",
    quantity: "250",
    limit_price: "0.42",
    time_in_force: "FOK",
    post_only: false,
    strategy_type: "wallet_follow",
    signal_id: "22222222-2222-4222-8222-222222222222",
    expires_at: "2027-06-01T12:02:00Z",
    ...over,
  };
}

const opts = { expectedAccountId: ACCOUNT, expectedVenue: "polymarket" };

describe("a contract payload becomes a domain intent", () => {
  it("populates every field the venue adapter needs", () => {
    // Without the adapter each of these is `undefined`, and `undefined`
    // in a price or a quantity is how an order is placed for the wrong
    // thing.
    const { intent } = parseIntentPayload(wirePayload(), opts);

    expect(intent.clientIntentId).toBe("11111111-1111-4111-8111-111111111111");
    expect(intent.quantity).toBe("250");
    expect(intent.limitPrice).toBe("0.42");
    expect(intent.timeInForce).toBe("FOK");
    expect(intent.side).toBe("BUY");
    expect(intent.instrument.conditionId).toBe("0xcond");
    expect(intent.instrument.outcomeTokenId).toBe("tok-1");
    expect(intent.expiresAt).toBe("2027-06-01T12:02:00Z");
  });

  it("carries the wire-only fields beside the intent, not inside it", () => {
    // signal_id and strategy_type belong in the audit trail. Putting
    // them on the domain intent would invite strategy logic into the
    // venue adapter, which is the coupling the two packages exist to
    // avoid.
    const env = parseIntentPayload(wirePayload(), opts);
    expect(env.signalId).toBe("22222222-2222-4222-8222-222222222222");
    expect(env.strategyType).toBe("wallet_follow");
    expect(env.accountId).toBe(ACCOUNT);
    expect("signalId" in env.intent).toBe(false);
  });
});

describe("schema_version is validated, as AGENTS.md requires", () => {
  it("accepts a version this executor knows", () => {
    expect(() => parseIntentPayload(wirePayload({ schema_version: "1.0.0" }), opts)).not.toThrow();
  });

  it("refuses a version it does not", () => {
    // A producer rolled forward past its consumer must fail loudly at
    // the boundary, not quietly place an order built from fields the
    // consumer ignored.
    expect(() => parseIntentPayload(wirePayload({ schema_version: "2" }), opts)).toThrow(
      /unsupported schema_version/,
    );
  });

  it("tolerates an absent version", () => {
    const p = wirePayload();
    delete p.schema_version;
    expect(() => parseIntentPayload(p, opts)).not.toThrow();
  });
});

describe("an intent for someone else is refused", () => {
  it("rejects a mismatched account", () => {
    // Not a degraded intent: it means a producer is writing into a
    // queue this executor drains, and dispatching would trade another
    // account's book.
    expect(() => parseIntentPayload(wirePayload({ account_id: "0xsomeone" }), opts)).toThrow(
      /this executor runs/,
    );
  });

  it("rejects a mismatched venue", () => {
    expect(() => parseIntentPayload(wirePayload({ venue: "kalshi" }), opts)).toThrow(/venue/);
  });
});

describe("a malformed payload throws rather than half-parsing", () => {
  it.each([
    ["intent_id", { intent_id: undefined }],
    ["account_id", { account_id: undefined }],
    ["quantity", { quantity: undefined }],
    ["limit_price", { limit_price: undefined }],
    ["instrument", { instrument: undefined }],
    ["signal_id", { signal_id: undefined }],
  ])("refuses a payload missing %s", (_name, over) => {
    expect(() => parseIntentPayload(wirePayload(over), opts)).toThrow(PayloadError);
  });

  it("refuses an unknown side", () => {
    expect(() => parseIntentPayload(wirePayload({ side: "HOLD" }), opts)).toThrow(/unknown side/);
  });

  it("refuses an unknown time_in_force", () => {
    expect(() => parseIntentPayload(wirePayload({ time_in_force: "IOC" }), opts)).toThrow(
      /unknown time_in_force/,
    );
  });

  it("names the offending field", () => {
    // A boundary that says only "invalid payload" makes the operator
    // diff two JSON blobs by eye at the worst possible moment.
    try {
      parseIntentPayload(wirePayload({ quantity: undefined }), opts);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as PayloadError).field).toBe("quantity");
    }
  });

  it("refuses a camelCase payload — the exact pre-PR-16 mistake", () => {
    // Someone hand-writing an intent against the domain type instead of
    // the contract produces this, and before PR 16 it would have been
    // accepted with every field undefined.
    const domainShaped = {
      clientIntentId: "x",
      instrument: { venue: "polymarket", conditionId: "c", outcomeTokenId: "t" },
      side: "BUY",
      quantity: "1",
      limitPrice: "0.5",
      timeInForce: "FOK",
    };
    expect(() => parseIntentPayload(domainShaped, opts)).toThrow(PayloadError);
  });
});
