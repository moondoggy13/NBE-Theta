// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type EventType =
  "submitted" | "acknowledged" | "partial_fill" | "fill" | "cancel_requested" | "canceled" | "rejected" | "expired";
export type Id = string;
export type OccurredAt = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type VenueOrderId = string;

/**
 * One row in the append-only ``venue_order_events`` table.
 *
 * Never rewrite an order row to erase history — write a new event and
 * project the current-state read model off events.
 */
export interface VenueOrderEvent {
  event_type: EventType;
  id: Id;
  occurred_at: OccurredAt;
  payload?: Payload;
  schema_version?: SchemaVersion;
  venue_order_id: VenueOrderId;
}
/**
 * Free-form event payload; keys/values are strings for wire stability.
 */
export interface Payload {
  [k: string]: string | undefined;
}
