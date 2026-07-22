// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type OutcomeIndex = number;
export type OutcomeName = string;
export type OutcomeTokenId = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Venue = "polymarket";
export type VenueMarketId = string;

/**
 * A row from a market's outcomes table.
 */
export interface Outcome {
  outcome_index: OutcomeIndex;
  outcome_name: OutcomeName;
  outcome_token_id: OutcomeTokenId;
  schema_version?: SchemaVersion;
  venue: Venue;
  venue_market_id: VenueMarketId;
}
