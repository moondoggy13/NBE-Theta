// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type AccountId = string;
export type ClientIntentId = string;
export type CreatedAt = string;
export type FeesPaid = string;
export type FilledQuantity = string;
export type ConditionId = string;
export type OutcomeTokenId = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Venue = "polymarket";
export type LimitPrice = string;
export type Quantity = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion1 = string;
export type Side = "BUY" | "SELL";
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
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK";
export type UpdatedAt = string;
export type Venue1 = "polymarket";
export type VenueOrderId = string;

/**
 * Executor-side snapshot of an order as we currently believe it.
 */
export interface VenueOrder {
  account_id: AccountId;
  client_intent_id: ClientIntentId;
  created_at: CreatedAt;
  fees_paid?: FeesPaid;
  filled_quantity?: FilledQuantity;
  instrument: OutcomeInstrument;
  limit_price: LimitPrice;
  quantity: Quantity;
  schema_version?: SchemaVersion1;
  side: Side;
  status: Status;
  time_in_force: TimeInForce;
  updated_at: UpdatedAt;
  venue: Venue1;
  venue_order_id: VenueOrderId;
}
/**
 * A tradable outcome token on a venue.
 *
 * Used everywhere the executor / signal side needs to identify a
 * specific YES/NO share. ``condition_id`` selects the market;
 * ``outcome_token_id`` selects the side of it.
 */
export interface OutcomeInstrument {
  condition_id: ConditionId;
  outcome_token_id: OutcomeTokenId;
  schema_version?: SchemaVersion;
  venue: Venue;
}
