/**
 * The venue interface. Polymarket is the first implementation; the shape
 * is deliberately venue-neutral so a second one is an adapter rather
 * than a rewrite (ADR-0001).
 *
 * Note what is absent: there is no `buy(symbol, qty)`. Every entry point
 * takes an `OrderIntent` carrying an explicit limit and TIF, because a
 * prediction-market order without a stated worst price is not a trade,
 * it is a hope.
 */
import type {
  CancelFilter,
  CancelResult,
  ExecutionReport,
  FillPage,
  OrderBook,
  OrderIntent,
  OutcomeInstrument,
  Subscription,
  UserEventHandler,
  VenueAccountState,
  VenueOrder,
  VenuePosition,
} from "./types.js";

export interface PredictionMarketVenue {
  getAccountState(): Promise<VenueAccountState>;
  getMarketBook(instrument: OutcomeInstrument): Promise<OrderBook>;

  /**
   * Submit one bounded order.
   *
   * Implementations MUST surface an ambiguous outcome as
   * `status: "unknown"` rather than throwing or reporting `rejected`. A
   * thrown timeout invites the caller to retry; `unknown` forces it to
   * reconcile, which is the only safe response to "we may or may not
   * have an order resting on the venue".
   */
  submitIntent(intent: OrderIntent): Promise<ExecutionReport>;

  cancelOrder(venueOrderId: string): Promise<void>;
  cancelAll(filter?: CancelFilter): Promise<CancelResult>;
  listOpenOrders(): Promise<VenueOrder[]>;
  listPositions(): Promise<VenuePosition[]>;
  listRecentFills(cursor?: string): Promise<FillPage>;
  subscribeUserEvents(handler: UserEventHandler): Promise<Subscription>;
}
