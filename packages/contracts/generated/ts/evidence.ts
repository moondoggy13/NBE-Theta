// AUTO-GENERATED — do not edit by hand.
// Regenerate with `pnpm --filter @nbe-theta/contracts generate`.
// Source: nbe_theta_contracts (Pydantic). See packages/contracts/README.md.

export type Kind = string;
export type Ref = string;
/**
 * Schema version of this payload; consumers reject on mismatch.
 */
export type SchemaVersion = string;
export type Weight = number;

/**
 * One item in a signal's evidence chain.
 *
 * ``kind`` is the evidence family (e.g. "wallet_trade", "cluster_agree",
 * "news_headline"); ``ref`` is a stable identifier the dashboard can
 * dereference (wallet address + tx hash, article URL, etc.). ``weight``
 * is the signal's own attribution — how much this evidence contributes
 * to the confidence score.
 */
export interface Evidence {
  detail?: Detail;
  kind: Kind;
  ref: Ref;
  schema_version?: SchemaVersion;
  weight: Weight;
}
export interface Detail {
  [k: string]: string | undefined;
}
