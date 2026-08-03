// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type AvgPrice = string | null;
export type CapturedAt = string;
export type CashPnl = string | null;
export type ConditionId = string;
export type CurPrice = string | null;
export type CurrentValue = string | null;
export type EndDate = string | null;
export type EventSlug = string | null;
export type InitialValue = string | null;
export type NegRisk = boolean;
export type OutcomeIndex = number | null;
export type OutcomeName = string | null;
export type OutcomeTokenId = string;
export type PercentPnl = string | null;
export type RealizedPnl = string | null;
export type Redeemable = boolean;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Size = string;
export type Slug = string | null;
export type Title = string | null;
export type TotalBought = string | null;
export type Venue = "polymarket";
export type Wallet = string;

/**
 * A tracked wallet's current holding of one outcome token.
 *
 * Snapshot semantics: the ingest layer replaces a wallet's full row
 * set on each refresh, so consumers treat ``captured_at`` as the
 * as-of time and absence as "no longer held". P&L fields are signed
 * (losses are negative); prices are [0, 1] marks — a resolved-losing
 * token legitimately marks at exactly 0.
 */
export interface WalletPositionSnapshot {
  avg_price?: AvgPrice;
  captured_at: CapturedAt;
  cash_pnl?: CashPnl;
  condition_id: ConditionId;
  cur_price?: CurPrice;
  current_value?: CurrentValue;
  end_date?: EndDate;
  event_slug?: EventSlug;
  initial_value?: InitialValue;
  neg_risk?: NegRisk;
  outcome_index?: OutcomeIndex;
  outcome_name?: OutcomeName;
  outcome_token_id: OutcomeTokenId;
  percent_pnl?: PercentPnl;
  realized_pnl?: RealizedPnl;
  redeemable?: Redeemable;
  schema_version?: SchemaVersion;
  size: Size;
  slug?: Slug;
  title?: Title;
  total_bought?: TotalBought;
  venue: Venue;
  wallet: Wallet;
}
