# ADR-0008: The wire/domain boundary, and venue truth persisted

- **Status**: Accepted
- **Date**: 2026-09-24
- **Deciders**: repository owner
- **Extends**: ADR-0002 (the seam), ADR-0006 (the lease), ADR-0007 (the
  producer)
- **Risk gate**: yes. Regression tests in
  `apps/executor/src/__tests__/{boundary,store.postgres}.test.ts`. Per
  AGENTS.md this also requires **review by someone other than its
  author**.

## Context

PR 15 gave the outbox a producer. Checking what the consumer would make
of a produced row turned up something that had never been visible,
because nothing wires claim to dispatch: **the two ends of the seam
describe the payload differently, and share not one field name.**

```
contract (packages/contracts, generated from Pydantic — the source of
truth AGENTS.md names for durable payloads):

  intent_id   account_id   limit_price   time_in_force   venue
  instrument.condition_id  instrument.outcome_token_id
  signal_id   strategy_type   post_only   schema_version

domain (packages/execution-domain, hand-written TypeScript):

  clientIntentId   limitPrice   timeInForce
  instrument.conditionId   instrument.outcomeTokenId
```

Reading a produced payload directly as a domain `OrderIntent` yields
`undefined` for every field, including quantity and price. This had not
caused an incident only because there is still no executor `main()`, so
a produced intent had never reached a consumer.

Two smaller findings came with it.

**`schema_version` was validated by nobody.** AGENTS.md: *"Every durable
payload includes `schema_version` as an explicit field and every
consumer validates against it."* The hand-written domain type does not
have the field, so the executor could not have validated it.

**Three status vocabularies disagreed.** The contract has ten statuses;
the domain type has eight, including `unknown` — which the venue
interface *requires* for an ambiguous submit — and `venue_orders.status`
was bare `text` accepting anything.

And separately: `venue_orders`, `venue_order_events` and `venue_fills`
have existed since migration 010 and were written by nothing and read by
nothing. An order could be placed and filled and leave no trace.

## Decision

**1. An explicit boundary, not a rename.** `apps/executor/src/boundary.ts`
parses a wire payload into a domain intent. The alternative — making the
execution layer use the generated contract types directly — was
rejected: the domain type is legitimately *narrower*, and a venue
adapter has no business knowing `signal_id` or `strategy_type`. Handing
it those invites strategy logic into execution, which is the coupling
the two packages exist to prevent. So the contract is the wire, the
domain type is internal, and one audited, tested function crosses
between them.

It throws rather than returning a partial object. A half-parsed intent
is how an order reaches a venue with `undefined` in a price.

**2. `schema_version` is validated at that boundary.** A producer rolled
forward past its consumer fails loudly there rather than quietly placing
an order built from fields the consumer ignored. An *absent* version is
tolerated (a producer predating versioned payloads); an explicitly
unsupported one is refused — different failures, different messages.

**3. An intent for another account or venue is refused.** Not a degraded
intent: it means a producer is writing into a queue this executor
drains, and dispatching it would trade someone else's book.

**4. An ambiguous submit never becomes an order row.** `status:
"unknown"` means we submitted and do not know what happened. A
`venue_orders` row asserts an order exists; that is precisely what we
cannot assert. It opens a `reconciliation_breaks` row instead — the
table that exists for "venue truth and local state disagree".

Migration 021 makes this structural by constraining
`venue_orders.status` to the contract's vocabulary, which has no
`unknown`. The code guard and the constraint are two halves of one
control: the guard gives a readable error, the constraint stops a future
writer that bypasses the store class.

**5. `filled_quantity` is a SUM over fills, never an increment.** This
is the difference between idempotent and not. A redelivered fill — a
reconnecting user stream replaying, a REST reconciliation overlapping
the socket — adds nothing when the total is recomputed and
double-counts when it is incremented. A position that reads larger than
it is, is the v2 failure shape from CLAUDE.md, and it is silent until
something sizes against it.

Events are append-only and the order row is a projection, which is what
the contract said all along: *"Never rewrite an order row to erase
history — write a new event and project the current-state read model off
events."*

## Consequences

- **Positive**: the seam's two ends now agree, and the disagreement is
  caught by a test rather than by an order placed with `undefined`
  fields.
- **Positive**: `schema_version` is validated somewhere for the first
  time.
- **Negative**: there are now *two* representations of an order intent
  in the repository, and a boundary to keep in step. That is the
  deliberate trade — the alternative couples execution to strategy —
  but a field added to the contract must be added here too or it is
  silently dropped. The boundary's tests are the place that fails when
  someone forgets.
- **Negative**: the status vocabularies still disagree between the
  contract and the domain type. This ADR constrains the *durable* one
  and leaves the in-memory one alone, because `unknown` is correct in
  memory and incoherent in storage. Converging them would mean removing
  a state the venue interface requires.

## Still open

**No live `strategy_lots` row is opened from a real fill.** The executor
now records what the venue did; nothing yet turns that into the
strategy-side position accounting Python owns. So `mode = 'live'`
currently produces intents, and — once a daemon exists — orders and
fills, but still no lot.

**There is still no executor `main()`.** Claim, boundary, dispatch and
record all exist and are tested individually; nothing runs them in
sequence. That remains deliberate per PR 10: wiring the loop to a venue
is the last step before real money moves.

## Related documents

- `docs/adr/0007-intent-producer.md` — the producer half
- `docs/adr/0006-intent-leases.md` — the claim's lease
- `apps/executor/src/boundary.ts`, `apps/executor/src/store.ts`
