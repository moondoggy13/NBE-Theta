# ADR-0007: Closing the execution seam — live enqueues, it does not simulate

- **Status**: Accepted
- **Date**: 2026-09-24
- **Deciders**: repository owner
- **Extends**: ADR-0002 (the seam), ADR-0006 (the consumer's lease)
- **Risk gate**: yes — this changes what `mode = 'live'` does.
  Regression tests in `python/tests/test_intent_seam_postgres.py`. Per
  AGENTS.md this also requires **review by someone other than its
  author**.

## Context

ADR-0002's central architectural resolution was one sentence:

> Python owns Intelligence + Signal. TypeScript owns Execution. **The
> seam is the durable `execution_intents` outbox, which already
> exists.**

Everything about that seam existed except the seam. The table has been
there since migration 010. The contracts — `OrderIntent`,
`ExecutionIntentRow` — since PR 2. The consumer since PR 10, and since
PR 14 it is tested against a real schema. **Nothing had ever written a
row.** The executor claimed from a queue that no producer filled, and
the two halves of the system had never been connected at all.

Looking for the producer surfaced a second problem, worse than the
absence.

`evaluate_action` took a `mode` argument and used it for exactly one
thing: labelling the strategy lot. The shadow broker ran in *every*
mode. So `mode = 'live'` meant:

1. qualify and size the signal, then
2. **simulate** a fill against the observed book, then
3. open a lot tagged `live`, priced from that simulation, and
4. never place an order.

The system would have recorded positions the account does not hold. That
is worse than recording nothing, because every downstream number — the
per-market cap, the correlated-cluster cap, the drawdown halt, the NAV
the console shows — is computed against the lot book. A book that lies
about what it owns makes all of them fiction, silently, in the direction
of permitting more risk.

## Decision

**1. `mode` decides where the decision goes, not how it is labelled.**

- `shadow` — unchanged. The shadow broker prices the order against the
  book we observed and opens a shadow lot. That is a *measurement*,
  deliberately pessimistic, and it is the evidence the shadow gate
  consumes (ADR-0003).
- `live` — evaluation stops after sizing. No simulation, no lot. The
  order is the executor's to place; the lot is opened later from the
  fill the venue actually reports.

**2. The intent is enqueued in the same transaction as its evaluation.**

This is the guarantee ADR-0002 rejected Redis for, quoted there as: *"an
execution intent must be enqueued in the same transaction that records
why it exists… a crash between 'record the decision' and 'enqueue the
order' either loses an order or duplicates one."* It had never been
exercised, because nothing enqueued. `record_evaluation` now writes both
or neither, and a rollback test proves it rather than asserting it.

**3. Shadow does not enqueue.** Shadow already has a fill path, and it
is the gate's evidence. Enqueuing as well would double-count every
copied trade — once in `shadow_fills`, once through the executor — and
corrupt the numbers the promotion decision is made on.

The cost of that choice is stated plainly below.

**4. The payload is built through the Pydantic contract**, not
assembled as a dict. A malformed intent then fails at the producer,
inside the transaction recording why it exists. The alternative is
discovering it in the executor after the claim, on a row that must then
go to `reconciliation_break` because nobody knows whether it reached the
venue.

**5. The dedupe key is the action's digest plus the policy version.** A
producer retrying after a network glitch inserts nothing the second
time. Including the policy version is deliberate: re-evaluating one
action under a *new* policy is a genuinely different decision and may
produce its own intent; re-running the same policy must not.

## Consequences

- **Positive**: the two halves of the system are connected for the
  first time, and the transactional property the architecture was
  chosen for is now demonstrated.
- **Positive**: live mode can no longer invent positions.
- **Negative, and the important one**: because shadow does not enqueue,
  **the producer's first firing in anger is live day**. Its SQL and its
  payload shape are exercised against a real schema in CI, so this is
  not the "never executed" state PR 14 found — but it has never run
  against a real signal stream. Before promoting, run the drill
  deliberately: set mode to `live` with the executor's three-flag gate
  *unset*, let intents accumulate and expire unclaimed, and inspect
  them. The alternative — enqueuing in shadow — was rejected because
  double-counting the gate's evidence is a worse failure than an
  unexercised path.
- **Negative**: `PostgresSignalStore` now takes an `account_id` for the
  live path. It is not defaulted, deliberately: an intent submitted
  against the wrong account should not be reachable by forgetting an
  argument.

## The other half is still open

`venue_orders` and `venue_fills` are written by **nothing** and read by
**nothing**. They exist (migration 010), they are anon-readable, they
sit in the realtime publication, and they are inert.

So the return path is missing: an intent can now be enqueued, claimed
(PR 14), and dispatched, but the resulting order and fill never land in
the database, and therefore no live lot is ever opened from a real fill.
Until that is built, `mode = 'live'` produces intents and no position
record at all.

That is deliberate scope, not an oversight, and it is the natural next
piece of work. It is recorded here rather than left to be rediscovered.

## Related documents

- `docs/adr/0002-overlord-copy-trading.md` — the seam, and why not Redis
- `docs/adr/0006-intent-leases.md` — the consumer's half
- `python/nbe_theta/signals/intents.py`
