// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type IntentId = string;
/**
 * Rejection reason from the venue or the executor's risk gate.
 */
export type Reason = string | null;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Status =
  | "pending"
  | "signed"
  | "submitted"
  | "live"
  | "partially_filled"
  | "cancel_pending"
  | "canceled"
  | "filled"
  | "rejected"
  | "expired";
export type SubmittedAt = string;
export type VenueOrderId = string | null;

/**
 * Immediate response to a submitIntent call.
 *
 * ``venue_order_id`` is present if the venue accepted the order and
 * returned an id. ``status`` is the current known state — ``live`` /
 * ``rejected`` / ``partially_filled`` / etc.
 */
export interface ExecutionReport {
  intent_id: IntentId;
  reason?: Reason;
  schema_version?: SchemaVersion;
  status: Status;
  submitted_at: SubmittedAt;
  venue_order_id?: VenueOrderId;
}
