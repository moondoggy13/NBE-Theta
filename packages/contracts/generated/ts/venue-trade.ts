// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type ConditionId = string;
export type MakerTaker = ("maker" | "taker") | null;
export type Notional = string;
export type OccurredAt = string;
export type OutcomeTokenId = string;
export type Price = string;
export type Quantity = string;
export type RawObjectId = string | null;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Side = "BUY" | "SELL";
export type SourceTradeId = string;
export type TxHash = string | null;
export type Venue = "polymarket";
export type Wallet = string;

/**
 * One observed trade by a tracked (or candidate) wallet.
 *
 * ``source_trade_id`` is the venue's stable id where one exists; the
 * Data API exposes none for /trades rows, so the ingest layer
 * synthesizes a canonical content hash — either way it is unique per
 * venue and is the dedupe key (``unique (venue, source_trade_id)``).
 */
export interface VenueTrade {
  condition_id: ConditionId;
  maker_taker?: MakerTaker;
  notional: Notional;
  occurred_at: OccurredAt;
  outcome_token_id: OutcomeTokenId;
  price: Price;
  quantity: Quantity;
  raw_object_id?: RawObjectId;
  schema_version?: SchemaVersion;
  side: Side;
  source_trade_id: SourceTradeId;
  tx_hash?: TxHash;
  venue: Venue;
  wallet: Wallet;
}
