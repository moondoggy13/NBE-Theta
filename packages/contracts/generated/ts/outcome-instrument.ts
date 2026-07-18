// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type ConditionId = string;
export type OutcomeTokenId = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Venue = "polymarket";

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
