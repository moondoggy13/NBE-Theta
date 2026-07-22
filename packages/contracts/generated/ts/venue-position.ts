// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type AccountId = string;
export type ConditionId = string;
export type CostBasis = string;
export type OutcomeTokenId = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Shares = string;
export type Venue = "polymarket";

/**
 * A per-outcome inventory row on a venue.
 *
 * ``shares`` is the signed inventory: positive = long the outcome,
 * negative = short it (Polymarket doesn't currently support short but
 * the shape stays neutral).
 * ``cost_basis`` is total dollars in for the current inventory;
 * combined with the last mid it produces unrealized P&L for the
 * dashboard.
 */
export interface VenuePosition {
  account_id: AccountId;
  condition_id: ConditionId;
  cost_basis?: CostBasis;
  outcome_token_id: OutcomeTokenId;
  schema_version?: SchemaVersion;
  shares: Shares;
  venue: Venue;
}
