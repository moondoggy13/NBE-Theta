// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type Fee = string;
export type Liquidity = "maker" | "taker";
export type OccurredAt = string;
export type Price = string;
export type Quantity = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type VenueFillId = string;
export type VenueOrderId = string;

/**
 * One fill against a venue order.
 */
export interface VenueFill {
  fee: Fee;
  liquidity: Liquidity;
  occurred_at: OccurredAt;
  price: Price;
  quantity: Quantity;
  schema_version?: SchemaVersion;
  venue_fill_id: VenueFillId;
  venue_order_id: VenueOrderId;
}
