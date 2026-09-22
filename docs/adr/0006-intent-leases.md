# ADR-0006: A claim on an execution intent is a lease

- **Status**: Accepted
- **Date**: 2026-09-22
- **Deciders**: repository owner
- **Extends**: ADR-0002 (the outbox, and why not Redis)
- **Risk gate**: yes. Regression test
  `apps/executor/src/__tests__/risk-gate-outbox-postgres.test.ts`. Per
  AGENTS.md this also requires **review by someone other than its
  author**.

## Context

PR 10 built the execution-intent outbox. AGENTS.md mandates it over
LISTEN/NOTIFY, and ADR-0002 rejected Redis for it, on one argument: an
intent must be enqueued in the same transaction that records why it
exists, and `FOR UPDATE SKIP LOCKED` then hands each row to exactly one
worker with no coordinator.

Reviewing it before wiring an entrypoint turned up two things.

**1. None of the SQL had ever been executed.** `CLAIM_SQL`,
`RELEASE_SQL` and `TERMINAL_SQL` are strings in a TypeScript module. No
executor test touches a database — they all mock the venue — so the
queries had been verified by reading them. That is exactly how two
non-existent columns (`process_heartbeats.updated_at`,
`operator_actions.created_at`) reached production in PR 9 and rendered
two console panels permanently empty in a way that looked like a healthy
idle system.

**2. A crashed worker stranded its intent forever.**

`CLAIM_SQL` moves a row to `status='claimed'` in a **committed** update.
`CLAIM_SQL` only ever selects `where status='ready'`. So:

```
worker claims  → commit → worker dies → row sits in 'claimed'
                                         nothing ever selects it again
```

No error, no `reconciliation_break`, no alert. The intent simply never
executes.

The outbox module's own docstring obscured this. It said a worker that
dies mid-claim "releases its lock when its transaction aborts" — true
only of a worker that dies *before* the claim commits. After the commit
there is no transaction and no lock: what stops a second worker taking
the row is the `status` value, not `SKIP LOCKED`. The comment described
the safe case and the unsafe one was the ordinary one — crash, OOM kill,
deploy, container reschedule.

For a copy-trading system this is the worst-shaped failure available.
A rejected intent is visible. A stranded intent means the operator
believes a wallet is being mirrored while silently it is not.

## Decision

**1. A claim is a lease.** Migration 020 adds
`execution_intents.lease_expires_at`; `CLAIM_SQL` sets it; `RECLAIM_SQL`
returns expired claims to `ready`.

**2. The reaper is deliberately conservative**, because the failure it
could introduce is worse than the one it fixes. Reclaiming an intent
whose worker is still alive dispatches the same order twice — the v2
failure class that cost $29k, per CLAUDE.md. So it:

- touches only `status = 'claimed'`, which excludes
  `reconciliation_break` and every terminal status *by construction*
  rather than by a list someone has to maintain;
- touches only leases that have actually expired;
- applies a backoff rather than re-offering immediately, so an intent
  that crashes its worker cannot become a hot loop.

**3. The lease must exceed the work, and that is enforced.**
`LEASE_SECONDS` is 300 against a coordinator whose work is a single
venue call with a second-scale timeout — a wide margin on purpose.
`assertLeaseExceedsWork` throws at startup if someone later raises a
venue timeout past the lease, rather than silently enabling duplicate
dispatch.

A heartbeat/renewal mechanism was considered and **not** built. It is
the right answer if work can legitimately outlive a lease; here it
cannot, and the assertion states and enforces that relationship. Adding
renewal now would be machinery guarding a condition that cannot arise.

**4. A NULL lease is treated as expired.** Rows claimed before this
migration have no lease and are, by definition, already stranded.
Backfilling a value would assert something nobody recorded.

**5. The SQL is now executed against a real schema in CI**, in the
`database` job — the only one with Postgres. The test **imports** the
query strings rather than copying them; a test with pasted SQL would
pass while the executor's actual SQL was broken, which is the whole
failure mode.

The job asserts the test *ran*. Without `DATABASE_URL` it self-skips,
and a silently-skipped integration test reads as green — a worse outcome
than not having one.

## Consequences

- **Positive**: a crashed executor no longer loses work. The recovery
  path is documented in `docs/runbooks/executor-recovery.md`.
- **Positive**: the property that justified the whole outbox design —
  concurrent claimers get disjoint sets — is now demonstrated rather
  than asserted. Removing `FOR UPDATE SKIP LOCKED` does not merely fail
  the test, it makes the two claimers deadlock until the suite is
  killed, which is a sharper signal than a failed assertion.
- **Negative**: a new `pg` devDependency, and the `database` CI job now
  needs a node toolchain it previously avoided (its comment noted that
  invoking `migrate.sh` directly kept it toolchain-free). That cost buys
  the first test in this repository that runs the executor's real
  queries.
- **Negative**: nothing *calls* `RECLAIM_SQL` yet. There is no executor
  `main()` — deliberately, per PR 10: wiring the loop to a venue is the
  last step before real money moves. The reaper is machinery waiting for
  that entrypoint, and until then a stranded intent still requires the
  runbook's manual query. This is honest rather than ideal, and it is
  called out in the runbook.

## Related documents

- `docs/adr/0002-overlord-copy-trading.md` — the outbox, and why not
  Redis
- `docs/runbooks/executor-recovery.md`
- `apps/executor/src/outbox.ts`
