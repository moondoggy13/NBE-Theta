// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type Category = string | null;
export type ClosesAt = string | null;
export type OpenedAt = string;
export type RawObjectId = string | null;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Status = "active" | "closed" | "resolved";
export type Title = string;
export type Venue = "polymarket";
export type VenueEventId = string;

/**
 * A real-world event that groups related markets.
 */
export interface Event {
  category?: Category;
  closes_at?: ClosesAt;
  opened_at: OpenedAt;
  raw_object_id?: RawObjectId;
  schema_version?: SchemaVersion;
  status: Status;
  title: Title;
  venue: Venue;
  venue_event_id: VenueEventId;
}
