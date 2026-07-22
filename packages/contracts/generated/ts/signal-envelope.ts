// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type Confidence = number;
export type CreatedAt = string;
export type Direction = "BUY" | "SELL";
export type Kind = string;
export type Ref = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Weight = number;
export type Evidence = Evidence1[];
export type ExpiresAt = string;
export type ConditionId = string;
export type OutcomeTokenId = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion1 = string;
export type Venue = "polymarket";
export type MaximumLossUsd = string;
export type MaximumPrice = string;
export type ModelVersion = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion2 = string;
export type SignalId = string;
export type StrategyType =
  | "wallet_follow"
  | "wallet_cluster_confirmation"
  | "fast_information_alert"
  | "news_probability"
  | "market_microstructure"
  | "future_cross_venue_arbitrage";

/**
 * The wire type a signal generator emits into the signal outbox.
 *
 * ``expires_at`` is the freshness deadline (the executor rejects the
 * intent if it stales). ``confidence`` is a probability in [0, 1] on
 * the signal's own model scale — NOT a calibrated market probability.
 *
 * Note: ``maximum_price`` and ``maximum_loss_usd`` are DECLARED by the
 * signal but ENFORCED by the executor's own risk snapshot; sizes here
 * are advisory, not authoritative.
 */
export interface SignalEnvelope {
  confidence: Confidence;
  created_at: CreatedAt;
  direction: Direction;
  evidence?: Evidence;
  expires_at: ExpiresAt;
  market: OutcomeInstrument;
  maximum_loss_usd: MaximumLossUsd;
  maximum_price: MaximumPrice;
  model_version: ModelVersion;
  schema_version?: SchemaVersion2;
  signal_id: SignalId;
  strategy_type: StrategyType;
}
/**
 * One item in a signal's evidence chain.
 *
 * ``kind`` is the evidence family (e.g. "wallet_trade", "cluster_agree",
 * "news_headline"); ``ref`` is a stable identifier the dashboard can
 * dereference (wallet address + tx hash, article URL, etc.). ``weight``
 * is the signal's own attribution — how much this evidence contributes
 * to the confidence score.
 */
export interface Evidence1 {
  detail?: Detail;
  kind: Kind;
  ref: Ref;
  schema_version?: SchemaVersion;
  weight: Weight;
}
export interface Detail {
  [k: string]: string | undefined;
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
  schema_version?: SchemaVersion1;
  venue: Venue;
}
