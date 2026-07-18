// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type AccountId = string;
export type CollateralBalance = string;
export type Connectivity = "ok" | "degraded" | "down";
export type OpenIntentCount = number;
export type OpenOrderCount = number;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Venue = "polymarket";

/**
 * Executor's known state of one venue account.
 *
 * ``collateral_balance`` is available margin / USDC. ``open_intent_count``
 * lets the risk engine reserve for in-flight orders.
 */
export interface VenueAccountState {
  account_id: AccountId;
  collateral_balance: CollateralBalance;
  connectivity?: Connectivity;
  open_intent_count: OpenIntentCount;
  open_order_count: OpenOrderCount;
  schema_version?: SchemaVersion;
  venue: Venue;
}
