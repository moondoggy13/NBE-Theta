# Runbook — executor recovery

**When:** an executor process died, was killed, or was redeployed while
holding claimed intents; or the console shows signals that produced no
orders.

**Read first:** `docs/adr/0006-intent-leases.md`.

> **Current state.** There is no executor `main()` yet — PR 10 left the
> loop unwired deliberately, because connecting it to a venue is the last
> step before real money moves. So **nothing calls `RECLAIM_SQL`
> automatically**. Until an entrypoint ships, the reclaim below is a
> manual operator action. The machinery and its tests are in place; the
> scheduler is not.

## The failure this addresses

`CLAIM_SQL` moves an intent to `status='claimed'` in a committed update,
and only ever selects rows `where status='ready'`. A worker that dies
after claiming therefore leaves its intent in `claimed`, where nothing
will pick it up again — no error, no break row, no alert.

`FOR UPDATE SKIP LOCKED` does not help: the claim is committed, so the
row lock is already gone. Double-claim protection comes from the status
value, not the lock.

## 1. Find stranded intents

```sql
select id,
       dedupe_key,
       claimed_by,
       claimed_at,
       lease_expires_at,
       attempt_count,
       expires_at < now() as intent_expired
  from execution_intents
 where status = 'claimed'
   and (lease_expires_at is null or lease_expires_at < now())
 order by claimed_at;
```

`lease_expires_at is null` means the claim predates migration 020 — it
has been stranded since whenever its worker died.

**Before reclaiming, confirm the worker is actually dead.** Reclaiming
under a live worker dispatches the same order twice, which is worse than
leaving it stranded. Check `process_heartbeats` for the process named in
`claimed_by`:

```sql
select process, last_beat, now() - last_beat as age
  from process_heartbeats
 order by last_beat desc;
```

A heartbeat younger than the lease means that worker is alive — do not
reclaim; it will finish or release on its own.

## 2. Reclaim

The lease predicate makes this safe against live workers, so prefer it
over a hand-written `UPDATE`:

```sql
-- $1 = backoff seconds before the intents become claimable again.
update execution_intents
   set status           = 'ready',
       claimed_at       = null,
       claimed_by       = null,
       lease_expires_at = null,
       available_at     = now() + ('60' || ' seconds')::interval,
       last_error       = 'lease expired; reclaimed from ' || coalesce(claimed_by, 'unknown'),
       updated_at       = now()
 where status = 'claimed'
   and (lease_expires_at is null or lease_expires_at < now())
returning id, dedupe_key, attempt_count;
```

This is `RECLAIM_SQL` from `apps/executor/src/outbox.ts` verbatim. Keep
them identical — the version in the module is the one under test.

## 3. Check for intents that expired while stranded

An intent has its own `expires_at`, separate from the lease. One
stranded past that point must **not** be re-dispatched: the copy
opportunity is gone and executing it now is a new trade nobody decided
on.

```sql
update execution_intents
   set status     = 'expired',
       last_error = 'stranded past expires_at during an executor outage',
       updated_at = now()
 where status = 'ready'
   and expires_at <= now()
returning id, dedupe_key;
```

## 4. What NOT to reclaim

- **`reconciliation_break`** — we submitted and do not know the outcome.
  Re-dispatch is precisely how the same order gets placed twice. These
  need reconciliation against venue truth (see the truth hierarchy in
  AGENTS.md), not requeueing.
- **Any terminal status** — `filled`, `canceled`, `rejected`, `expired`,
  `settled`.

The reclaim query above excludes all of these by scoping to
`status = 'claimed'`. That is why it is scoped that way rather than by a
list of statuses to avoid.

## 5. Afterwards

Record what happened:

```sql
insert into operator_actions (actor, action, detail)
values ('<your name>', 'executor_recovery',
        jsonb_build_object('reclaimed', <n>, 'expired', <n>, 'cause', '<what died>'));
```

If a poison intent is crash-looping — the same `dedupe_key` reappearing
with a climbing `attempt_count` — do not keep reclaiming it. Move it to
`rejected` with a `last_error` saying why, and open an issue with its
payload. `backoffSeconds` caps at 300s, so a poison message costs one
attempt every five minutes indefinitely rather than announcing itself.

## Related

- `docs/adr/0006-intent-leases.md`
- `docs/runbooks/manage-operators.md`
- AGENTS.md — truth hierarchy for order state
