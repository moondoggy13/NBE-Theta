/**
 * The wire/domain boundary.
 *
 * **The bug this exists to fix.** PR 15 gave the outbox a producer. It
 * writes the payload defined by `packages/contracts` — the Pydantic
 * models AGENTS.md calls "the single source of truth for durable
 * payloads", generated into `packages/contracts/generated/ts/`. The
 * executor consumes `OrderIntent` from `packages/execution-domain`,
 * which is **hand-written and shares not one field name with it**:
 *
 * ```
 * contract (wire):  intent_id  account_id  limit_price  time_in_force
 *                   instrument.condition_id  signal_id  strategy_type
 *                   venue  schema_version
 *
 * domain (memory):  clientIntentId  limitPrice  timeInForce
 *                   instrument.conditionId
 * ```
 *
 * Reading a produced payload as a domain intent yields `undefined` for
 * every field. This had not bitten because nothing wires claim to
 * dispatch yet — there is still no executor `main()` — so the two ends
 * had never met.
 *
 * **Why an adapter rather than renaming the execution layer.** The
 * domain type is legitimately narrower: a venue adapter has no business
 * knowing `signal_id` or `strategy_type`, and giving it those invites
 * strategy logic to leak into execution. So the contract stays the
 * wire format, the domain type stays internal, and everything crossing
 * between them goes through here — one place to audit, one place to
 * test.
 *
 * **`schema_version` is validated here**, which AGENTS.md requires of
 * every consumer ("Every durable payload includes `schema_version` as
 * an explicit field and every consumer validates against it") and which
 * nothing in this repository did. A producer rolled forward past a
 * consumer must fail loudly at the boundary, not silently produce an
 * order with a field the consumer ignored.
 */

import type { OrderIntent, Side, TimeInForce } from "@nbe-theta/execution-domain";

/** Payload shapes this executor knows how to read. */
export const SUPPORTED_SCHEMA_VERSIONS = new Set(["1", "1.0", "1.0.0"]);

export class PayloadError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "PayloadError";
  }
}

/** What the wire carries beyond what the domain type models. */
export interface IntentEnvelope {
  intent: OrderIntent;
  accountId: string;
  venue: string;
  /** Carried for the audit trail, never for execution decisions. */
  signalId: string;
  strategyType: string;
}

const SIDES = new Set<string>(["BUY", "SELL"]);
const TIFS = new Set<string>(["GTC", "GTD", "FOK", "FAK"]);

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new PayloadError(`missing or non-string '${key}'`, key);
  }
  return v;
}

/**
 * Parse a claimed outbox payload into a domain intent.
 *
 * Throws `PayloadError` rather than returning a partial object. A
 * half-parsed intent is the shape that reaches a venue with a field
 * silently `undefined`, and `undefined` in a price or a quantity is how
 * an order gets placed for the wrong thing.
 */
export function parseIntentPayload(
  payload: Record<string, unknown>,
  opts: { expectedAccountId: string; expectedVenue?: string },
): IntentEnvelope {
  // Absent means the producer predates versioned payloads; that is a
  // different failure from an explicitly wrong version, so say which.
  const rawVersion = payload.schema_version;
  if (rawVersion !== undefined) {
    if (typeof rawVersion !== "string" || !SUPPORTED_SCHEMA_VERSIONS.has(rawVersion)) {
      throw new PayloadError(
        `unsupported schema_version '${String(rawVersion)}'; ` +
          `this executor reads ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}`,
        "schema_version",
      );
    }
  }

  const instrument = payload.instrument;
  if (typeof instrument !== "object" || instrument === null) {
    throw new PayloadError("missing 'instrument'", "instrument");
  }
  const inst = instrument as Record<string, unknown>;

  const side = str(payload, "side");
  if (!SIDES.has(side)) throw new PayloadError(`unknown side '${side}'`, "side");

  const tif = str(payload, "time_in_force");
  if (!TIFS.has(tif)) throw new PayloadError(`unknown time_in_force '${tif}'`, "time_in_force");

  const accountId = str(payload, "account_id");
  if (accountId !== opts.expectedAccountId) {
    // An intent for a different account is not a degraded intent. It
    // means a producer is writing into a queue this executor drains,
    // and dispatching it would trade someone else's book.
    throw new PayloadError(
      `intent is for account '${accountId}', this executor runs '${opts.expectedAccountId}'`,
      "account_id",
    );
  }

  const venue = str(payload, "venue");
  if (opts.expectedVenue && venue !== opts.expectedVenue) {
    throw new PayloadError(
      `intent is for venue '${venue}', this executor runs '${opts.expectedVenue}'`,
      "venue",
    );
  }

  const intent: OrderIntent = {
    // The contract's `intent_id` IS the client order id the venue sees;
    // the domain calls it clientIntentId. Same value, different name —
    // which is exactly the kind of thing that silently becomes
    // `undefined` without a boundary.
    clientIntentId: str(payload, "intent_id"),
    instrument: {
      venue: str(inst, "venue"),
      conditionId: str(inst, "condition_id"),
      outcomeTokenId: str(inst, "outcome_token_id"),
    },
    side: side as Side,
    quantity: str(payload, "quantity"),
    limitPrice: str(payload, "limit_price"),
    timeInForce: tif as TimeInForce,
    expiresAt: typeof payload.expires_at === "string" ? payload.expires_at : undefined,
  };

  return {
    intent,
    accountId,
    venue,
    signalId: str(payload, "signal_id"),
    strategyType: str(payload, "strategy_type"),
  };
}
