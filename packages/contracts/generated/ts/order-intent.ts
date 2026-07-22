// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type AccountId = string;
export type Expiration = string | null;
export type ExpiresAt = string;
export type ConditionId = string;
export type OutcomeTokenId = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Venue = "polymarket";
export type IntentId = string;
export type LimitPrice = string;
export type PostOnly = boolean;
export type Quantity = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion1 = string;
export type Side = "BUY" | "SELL";
export type SignalId = string;
export type StrategyType =
  | "wallet_follow"
  | "wallet_cluster_confirmation"
  | "fast_information_alert"
  | "news_probability"
  | "market_microstructure"
  | "future_cross_venue_arbitrage";
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK";
export type Venue1 = "polymarket";

/**
 * The venue-neutral intent the executor consumes from the outbox.
 *
 * Limit orders are the wire primitive — there is no market order.
 * An immediate purchase is a marketable limit with an explicit
 * ``limit_price`` (the executor's max acceptable price).
 *
 * ``expiration`` is only meaningful for ``time_in_force == "GTD"``;
 * consumers ignore it otherwise. ``expires_at`` is separate: it's the
 * signal-freshness deadline used by the pre-order risk check.
 */
export interface OrderIntent {
  account_id: AccountId;
  expiration?: Expiration;
  expires_at: ExpiresAt;
  instrument: OutcomeInstrument;
  intent_id: IntentId;
  limit_price: LimitPrice;
  post_only?: PostOnly;
  quantity: Quantity;
  schema_version?: SchemaVersion1;
  side: Side;
  signal_id: SignalId;
  strategy_type: StrategyType;
  time_in_force: TimeInForce;
  venue: Venue1;
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
