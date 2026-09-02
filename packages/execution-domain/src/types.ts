/**
 * Venue-neutral execution types.
 *
 * Shaped for prediction markets, which differ from a spot broker in ways
 * that matter enough to justify not reusing a `BrokerClient` shape
 * (CLAUDE.md lists that as a thing never to reintroduce):
 *
 * - A market is a `conditionId` with several `outcomeTokenId`s, not one
 *   symbol. YES and NO are separate instruments with separate inventory.
 * - Loss is **principal-bounded**: the most a long position can lose is
 *   what was paid for it. `contracts × price + fees`, not a
 *   marked-to-market spiral. Sizing and risk read very differently as a
 *   result.
 * - There are **no market orders**. Every order is a limit with an
 *   explicit time-in-force; an "immediate buy" is a marketable limit with
 *   a stated worst price. An unbounded order in a thin prediction market
 *   is a donation.
 *
 * Prices and quantities are strings on the wire and `number` only where
 * arithmetic is local and bounded. Anything durable crosses through
 * `packages/contracts`, where Decimals are strings with bound-encoding
 * patterns.
 */

/** Time in force. No `MARKET` — see the module docstring. */
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK";

export type Side = "BUY" | "SELL";

export type OrderStatus =
  | "pending"
  | "live"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired"
  /**
   * We submitted and do not know what happened — a timeout, a reset, an
   * ambiguous 5xx. This is a real state, not an error to swallow: it is
   * the one that must trigger reconciliation rather than a retry, and
   * collapsing it into `rejected` is how a system places the same order
   * twice.
   */
  | "unknown";

/** The instrument. A market plus one of its outcome tokens. */
export interface OutcomeInstrument {
  venue: string;
  conditionId: string;
  outcomeTokenId: string;
}

/**
 * Stable identity for locking and idempotency.
 *
 * Includes the account: two accounts trading the same outcome are
 * genuinely independent and must not serialise against each other.
 */
export function instrumentKey(account: string, i: OutcomeInstrument): string {
  return `${i.venue}:${account}:${i.conditionId}:${i.outcomeTokenId}`;
}

export interface OrderIntent {
  /**
   * Deterministic, derived from the signal that caused it. The venue
   * sees it as a client order id, so a resubmission of the same
   * intent is recognisable as the same order rather than a new one.
   */
  clientIntentId: string;
  instrument: OutcomeInstrument;
  side: Side;
  quantity: string;
  /** Worst acceptable price. Never absent — there are no market orders. */
  limitPrice: string;
  timeInForce: TimeInForce;
  expiresAt?: string;
}

export interface ExecutionReport {
  clientIntentId: string;
  venueOrderId: string | null;
  status: OrderStatus;
  filledQuantity: string;
  avgPrice: string | null;
  feesPaid: string;
  /** Present when the venue rejected, or when we could not tell. */
  reason?: string;
  observedAt: string;
}

export interface VenueOrder {
  venueOrderId: string;
  clientIntentId: string;
  instrument: OutcomeInstrument;
  side: Side;
  quantity: string;
  limitPrice: string;
  timeInForce: TimeInForce;
  status: OrderStatus;
  filledQuantity: string;
}

export interface VenueFill {
  venueOrderId: string;
  instrument: OutcomeInstrument;
  side: Side;
  quantity: string;
  price: string;
  fee: string;
  occurredAt: string;
}

export interface VenuePosition {
  instrument: OutcomeInstrument;
  /** Signed. Negative is only ever the result of a venue-side event; the
   * copy strategy never opens shorts (see signals/lots.py). */
  quantity: string;
  avgPrice: string | null;
}

export interface VenueAccountState {
  accountId: string;
  /** Free collateral, in USDC. */
  availableCash: string;
  /** Cash committed to resting orders. Counted against buying power. */
  reservedCash: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  instrument: OutcomeInstrument;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  observedAt: string;
}

export interface CancelFilter {
  conditionId?: string;
  outcomeTokenId?: string;
}

export interface CancelResult {
  canceled: string[];
  failed: { venueOrderId: string; reason: string }[];
}

export interface FillPage {
  fills: VenueFill[];
  cursor: string | null;
}

export type UserEvent =
  | { kind: "order"; order: VenueOrder }
  | { kind: "fill"; fill: VenueFill };

export type UserEventHandler = (event: UserEvent) => void;

export interface Subscription {
  close(): void;
}
