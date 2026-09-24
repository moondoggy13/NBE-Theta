/**
 * Durable intent outbox.
 *
 * AGENTS.md: *"No LISTEN/NOTIFY as the durable delivery mechanism. Use
 * the `execution_intents` outbox with `FOR UPDATE SKIP LOCKED`. NOTIFY
 * is a wake-up hint only."*
 *
 * The reason is transactional, not stylistic. An execution intent must
 * be enqueued in the **same transaction** that records why it exists —
 * the signal evaluation, the risk snapshot, the lot it will open. A
 * queue that lives outside the database cannot participate in that
 * transaction, so a crash between "record the decision" and "enqueue the
 * order" either loses an order or duplicates one. Both are unacceptable
 * with money attached, and neither is detectable after the fact.
 *
 * `FOR UPDATE SKIP LOCKED` gives multiple executor replicas a safe claim
 * with no coordinator: each row goes to exactly one worker.
 *
 * **What the lock does not do** — this used to say a worker that dies
 * mid-claim "releases its lock when its transaction aborts", which is
 * true only of a worker that dies *before* the claim commits. `CLAIM_SQL`
 * is a committed UPDATE: once it returns there is no transaction and no
 * lock, and what stops a second worker taking the row is the `status`
 * value, not `SKIP LOCKED`. So the ordinary crash — claim commits, then
 * the process dies — left the row in `claimed` where nothing selects it,
 * forever.
 *
 * A claim is therefore a **lease** (migration 020). It carries an expiry,
 * and `RECLAIM_SQL` returns expired claims to `ready`. See
 * docs/adr/0006-intent-leases.md.
 *
 * This module is SQL-shaped rather than an ORM on purpose — the claim
 * query's exact semantics are the safety property, and they should be
 * readable in one place.
 */

/**
 * How long a claim stays valid.
 *
 * This must comfortably exceed the longest time a worker can legitimately
 * hold an intent, because a lease that expires under a *live* worker
 * causes the same intent to be dispatched twice — the v2 failure class,
 * and far worse than the stranding it is meant to fix. Five minutes
 * against a coordinator whose work is a single venue call with a
 * second-scale timeout is a wide margin on purpose.
 *
 * `assertLeaseExceedsWork` below keeps that relationship honest rather
 * than leaving it to a comment.
 */
export const LEASE_SECONDS = 300;

/**
 * Guard the invariant that makes the reaper safe.
 *
 * Called with the coordinator's worst-case per-intent budget. If someone
 * later raises a venue timeout past the lease, this throws at startup
 * instead of silently enabling double dispatch.
 */
export function assertLeaseExceedsWork(maxWorkSeconds: number): void {
  if (maxWorkSeconds >= LEASE_SECONDS) {
    throw new Error(
      `lease of ${LEASE_SECONDS}s does not exceed max work time of ${maxWorkSeconds}s; ` +
        "a lease that can expire under a live worker causes duplicate dispatch",
    );
  }
}

export const CLAIM_SQL = `
  update execution_intents
     set status           = 'claimed',
         claimed_at       = now(),
         claimed_by       = $1,
         lease_expires_at = now() + ($3 || ' seconds')::interval,
         attempt_count    = attempt_count + 1,
         updated_at       = now()
   where id in (
     select id
       from execution_intents
      where status = 'ready'
        and available_at <= now()
        and expires_at   > now()
      order by created_at
        for update skip locked
      limit $2
   )
  returning id, strategy_type, dedupe_key, payload, attempt_count, expires_at
`;

/**
 * Return expired claims to `ready`.
 *
 * Three things this is careful about, each of which would be a bug in a
 * more eager version:
 *
 * 1. **It only touches `status = 'claimed'`.** A row in
 *    `reconciliation_break` — we submitted and do not know the outcome —
 *    must never re-enter the queue, and neither must anything terminal.
 *    Scoping to `claimed` excludes them by construction rather than by a
 *    list someone has to maintain.
 * 2. **It only touches leases that have actually expired.** `now() >
 *    lease_expires_at`, never `>=` against a lease computed in the same
 *    statement, and never a row whose lease is still running. Reclaiming
 *    live work dispatches the same intent twice.
 * 3. **It applies backoff rather than re-offering immediately.** An
 *    intent that crashes its worker will crash the next one too; without
 *    backoff the reaper turns one poison message into a hot loop.
 *    `attempt_count` is already incremented by CLAIM_SQL, so the existing
 *    backoff schedule applies unchanged.
 *
 * A NULL lease means a claim made before migration 020 — already
 * stranded, by definition — so it is treated as expired.
 */
export const RECLAIM_SQL = `
  update execution_intents
     set status           = 'ready',
         claimed_at       = null,
         claimed_by       = null,
         lease_expires_at = null,
         available_at     = now() + ($1 || ' seconds')::interval,
         last_error       = 'lease expired; reclaimed from ' || coalesce(claimed_by, 'unknown'),
         updated_at       = now()
   where status = 'claimed'
     and (lease_expires_at is null or lease_expires_at < now())
  returning id, dedupe_key, attempt_count
`;

/**
 * Release a claim back to `ready` with a backoff.
 *
 * Used when a worker cannot complete an intent for a reason that may
 * resolve — never after an ambiguous submit. An intent whose order may
 * be resting on the venue must go to `reconciliation_break`, not back
 * into the queue, because re-dispatching it is precisely how the same
 * order gets placed twice.
 */
export const RELEASE_SQL = `
  update execution_intents
     set status       = 'ready',
         claimed_at   = null,
         claimed_by   = null,
         available_at = now() + ($2 || ' seconds')::interval,
         last_error   = $3,
         updated_at   = now()
   where id = $1
`;

export const TERMINAL_SQL = `
  update execution_intents
     set status     = $2,
         last_error = $3,
         updated_at = now()
   where id = $1
`;

export interface ClaimedIntent {
  id: string;
  strategyType: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  expiresAt: string;
}

/**
 * Backoff for a *retryable* failure.
 *
 * Capped, and deliberately not jittered here: the claim query already
 * serialises workers, so the thundering-herd problem jitter solves does
 * not arise. What matters is that a repeatedly failing intent backs off
 * far enough to stop burning rate budget.
 */
export function backoffSeconds(attemptCount: number): number {
  // One cap, not two. An earlier version capped the exponent at 8 as
  // well, which silently made the 300s ceiling unreachable — 2**8 is
  // 256, so the outer Math.min never bound anything. A ceiling that
  // cannot be reached is not a ceiling, and it reads like a guarantee
  // the code does not actually make.
  //
  // A very large attemptCount overflows 2**n to Infinity, which Math.min
  // handles correctly.
  return Math.min(300, 2 ** attemptCount);
}

/**
 * Statuses from which an intent must never be re-dispatched.
 *
 * `reconciliation_break` is the important one: it means we submitted and
 * do not know the outcome. Re-dispatch would risk a duplicate order, so
 * it requires an operator or a successful reconciliation to move on.
 */
export const NON_REDISPATCHABLE = new Set([
  "filled",
  "canceled",
  "rejected",
  "expired",
  "settled",
  "reconciliation_break",
]);

export function isRedispatchable(status: string): boolean {
  return !NON_REDISPATCHABLE.has(status);
}
