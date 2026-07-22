// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type Active = boolean;
export type Closed = boolean;
export type ClosesAt = string | null;
export type ConditionId = string;
export type CurrentRuleVersionId = string | null;
export type NegRisk = boolean;
export type OpenedAt = string;
export type OutcomeIndex = number;
export type OutcomeName = string;
export type OutcomeTokenId = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Venue = "polymarket";
export type VenueMarketId = string;
export type Outcomes = Outcome[];
export type Question = string;
export type ResolutionSource = string | null;
export type Resolved = boolean;
export type ResolvedAt = string | null;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion1 = string;
export type Venue1 = "polymarket";
export type VenueEventId = string;
export type VenueMarketId1 = string;

/**
 * A single market on a venue.
 */
export interface Market {
  active: Active;
  closed: Closed;
  closes_at?: ClosesAt;
  condition_id: ConditionId;
  current_rule_version_id?: CurrentRuleVersionId;
  neg_risk?: NegRisk;
  opened_at: OpenedAt;
  outcomes?: Outcomes;
  question: Question;
  resolution_source?: ResolutionSource;
  resolved: Resolved;
  resolved_at?: ResolvedAt;
  schema_version?: SchemaVersion1;
  venue: Venue1;
  venue_event_id: VenueEventId;
  venue_market_id: VenueMarketId1;
}
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
