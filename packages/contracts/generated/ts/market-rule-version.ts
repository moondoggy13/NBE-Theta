// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type CloseTime = string | null;
export type Description = string | null;
export type Id = string;
export type ObservedAt = string;
export type RawObjectId = string | null;
export type ResolutionSource = string | null;
export type RuleHash = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Title = string;
export type Venue = "polymarket";
export type VenueMarketId = string;

/**
 * An observed version of a market's resolution rules.
 *
 * We snapshot each observation with a ``rule_hash`` so a mid-market
 * rule change becomes a new row rather than an in-place edit.
 */
export interface MarketRuleVersion {
  close_time?: CloseTime;
  description?: Description;
  id: Id;
  observed_at: ObservedAt;
  raw_object_id?: RawObjectId;
  resolution_source?: ResolutionSource;
  rule_hash: RuleHash;
  schema_version?: SchemaVersion;
  title: Title;
  venue: Venue;
  venue_market_id: VenueMarketId;
}
