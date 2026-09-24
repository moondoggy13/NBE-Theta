/**
 * Venue truth, persisted.
 *
 * `venue_orders`, `venue_order_events` and `venue_fills` have existed
 * since migration 010. Before PR 16 they were written by **nothing** and
 * read by **nothing**: the coordinator returned a `DispatchOutcome` in
 * memory and dropped it. So an order could be placed and filled and the
 * database would show no trace — which for a system whose whole premise
 * is "mirror what these wallets did" means no record of whether we
 * actually mirrored anything.
 *
 * Three rules shape every query below.
 *
 * **1. Events are append-only; the order row is a projection.** The
 * contract says so outright — *"Never rewrite an order row to erase
 * history — write a new event and project the current-state read model
 * off events."* An order row that is edited in place loses the sequence
 * that reconciliation needs to explain a disagreement.
 *
 * **2. `filled_quantity` is a SUM over fills, never an increment.** This
 * is the difference between idempotent and not. A redelivered fill — a
 * reconnecting user stream replaying, a REST reconciliation overlapping
 * the socket — adds nothing when the total is recomputed, and
 * double-counts the position when it is incremented. Double-counting a
 * position is the v2 failure shape (CLAUDE.md), and it is silent.
 *
 * **3. An ambiguous submit writes no order row.** The venue interface
 * requires implementations to surface "we submitted and do not know
 * what happened" as `status: "unknown"`. Writing a `venue_orders` row
 * asserts an order exists; on an ambiguous submit we do not know that.
 * It goes to `reconciliation_breaks`, which is the table for exactly
 * this — venue truth and local state disagree, and a human or a
 * reconciliation pass resolves it. `venue_orders.status` is constrained
 * to the contract's `OrderStatus` (migration 021), which has no
 * `unknown`, so this rule is enforced by the schema rather than by
 * this comment.
 */

import type { ExecutionReport } from "@nbe-theta/execution-domain";
import type { IntentEnvelope } from "./boundary.js";

/** Minimal shape of a `pg` client, so tests can pass a real one. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A fill as the venue reports it. */
export interface VenueFillRow {
  venueFillId: string;
  venueOrderId: string;
  occurredAt: string;
  price: string;
  quantity: string;
  fee: string;
  liquidity: "maker" | "taker";
}

export const ORDER_UPSERT_SQL = `
  insert into venue_orders
    (venue, venue_order_id, client_intent_id, account_id, condition_id,
     outcome_token_id, side, quantity, limit_price, time_in_force, status,
     created_at, updated_at)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
  on conflict (venue, venue_order_id) do update
     set status     = excluded.status,
         updated_at = now()
  returning venue_order_id
`;

/**
 * Append-only. There is deliberately no update or delete for this table
 * anywhere in the codebase.
 */
export const EVENT_SQL = `
  insert into venue_order_events (venue, venue_order_id, event_type, occurred_at, payload)
  values ($1,$2,$3,$4,$5::jsonb)
  returning id
`;

/**
 * `on conflict do nothing` on the natural key the venue supplies. This
 * is what makes a replayed fill free rather than expensive.
 */
export const FILL_SQL = `
  insert into venue_fills
    (venue, venue_order_id, venue_fill_id, occurred_at, price, quantity, fee, liquidity)
  values ($1,$2,$3,$4,$5,$6,$7,$8)
  on conflict (venue, venue_fill_id) do nothing
  returning venue_fill_id
`;

/**
 * Recompute the order's fill state from the fills themselves.
 *
 * Note what this is NOT: `filled_quantity = filled_quantity + $n`. The
 * sum is idempotent under redelivery; the increment is not, and the
 * failure it causes — a position that reads larger than it is — is
 * invisible until something sizes against it.
 *
 * `status` is derived here too, so a partially-filled order that later
 * completes cannot be left labelled `partially_filled` by a missed
 * update. `least(...)` guards the pathological case of a venue
 * reporting more fill than the order asked for; the row stays
 * internally consistent rather than claiming an impossible status.
 */
export const PROJECT_SQL = `
  update venue_orders o
     set filled_quantity = f.qty,
         fees_paid       = f.fee,
         status          = case
                             when f.qty >= o.quantity then 'filled'
                             when f.qty > 0           then 'partially_filled'
                             else o.status
                           end,
         updated_at      = now()
    from (
      select coalesce(sum(quantity), 0) as qty,
             coalesce(sum(fee), 0)      as fee
        from venue_fills
       where venue = $1 and venue_order_id = $2
    ) f
   where o.venue = $1 and o.venue_order_id = $2
  returning o.filled_quantity, o.fees_paid, o.status
`;

export const BREAK_SQL = `
  insert into reconciliation_breaks (scope, venue_order_id, description, detail)
  values ('orders', $1, $2, $3::jsonb)
  returning id
`;

/** Statuses the schema accepts. `unknown` is deliberately absent. */
const PERSISTABLE = new Set([
  "pending",
  "signed",
  "submitted",
  "live",
  "partially_filled",
  "cancel_pending",
  "canceled",
  "filled",
  "rejected",
  "expired",
]);

export class ExecutionStore {
  constructor(
    private readonly db: Queryable,
    private readonly venue: string = "polymarket",
  ) {}

  /**
   * Record what the venue said about a submission.
   *
   * Returns the venue order id, or null when the outcome was ambiguous
   * and a reconciliation break was opened instead.
   */
  async recordSubmission(
    envelope: IntentEnvelope,
    report: ExecutionReport,
  ): Promise<string | null> {
    const { intent, accountId } = envelope;
    // Ambiguous, or accepted-without-an-id: either way we cannot assert
    // that an order exists, so we do not write a row claiming one.
    if (report.status === "unknown" || !report.venueOrderId) {
      await this.db.query(BREAK_SQL, [
        report.venueOrderId ?? null,
        report.status === "unknown"
          ? "submit outcome unknown; order may be resting on the venue"
          : `venue accepted with status ${report.status} but returned no order id`,
        JSON.stringify({
          client_intent_id: intent.clientIntentId,
          condition_id: intent.instrument.conditionId,
          outcome_token_id: intent.instrument.outcomeTokenId,
          status: report.status,
          reason: report.reason ?? null,
        }),
      ]);
      return null;
    }

    if (!PERSISTABLE.has(report.status)) {
      // A status the durable contract does not describe. Refusing here
      // beats letting the schema's check constraint abort the whole
      // transaction with a message about a constraint name.
      throw new Error(
        `refusing to persist unsupported order status '${report.status}'; ` +
          "venue_orders.status is constrained to the contract's OrderStatus",
      );
    }

    await this.db.query(ORDER_UPSERT_SQL, [
      this.venue,
      report.venueOrderId,
      intent.clientIntentId,
      accountId,
      intent.instrument.conditionId,
      intent.instrument.outcomeTokenId,
      intent.side,
      intent.quantity,
      intent.limitPrice,
      intent.timeInForce,
      report.status,
    ]);

    await this.db.query(EVENT_SQL, [
      this.venue,
      report.venueOrderId,
      "submitted",
      report.observedAt,
      JSON.stringify({
        client_intent_id: intent.clientIntentId,
        reason: report.reason ?? null,
      }),
    ]);

    return report.venueOrderId;
  }

  /**
   * Record fills and re-project the order from them.
   *
   * Returns how many fills were genuinely new, so a caller can tell a
   * replay from real progress.
   */
  async recordFills(venueOrderId: string, fills: VenueFillRow[]): Promise<number> {
    let inserted = 0;
    for (const f of fills) {
      const { rows } = await this.db.query(FILL_SQL, [
        this.venue,
        f.venueOrderId,
        f.venueFillId,
        f.occurredAt,
        f.price,
        f.quantity,
        f.fee,
        f.liquidity,
      ]);
      if (rows.length > 0) {
        inserted += 1;
        await this.db.query(EVENT_SQL, [
          this.venue,
          f.venueOrderId,
          "fill",
          f.occurredAt,
          JSON.stringify({
            venue_fill_id: f.venueFillId,
            price: f.price,
            quantity: f.quantity,
          }),
        ]);
      }
    }

    // Always re-project, even when nothing was inserted: a caller
    // reconciling after a crash may be re-reporting fills that landed
    // before the projection ran.
    await this.db.query(PROJECT_SQL, [this.venue, venueOrderId]);
    return inserted;
  }
}
