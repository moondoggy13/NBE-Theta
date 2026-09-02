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
 * with no coordinator: each row goes to exactly one worker, and a worker
 * that dies mid-claim releases its lock when its transaction aborts.
 *
 * This module is SQL-shaped rather than an ORM on purpose — the claim
 * query's exact semantics are the safety property, and they should be
 * readable in one place.
 */

export const CLAIM_SQL = `
  update execution_intents
     set status        = 'claimed',
         claimed_at    = now(),
         claimed_by    = $1,
         attempt_count = attempt_count + 1,
         updated_at    = now()
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
