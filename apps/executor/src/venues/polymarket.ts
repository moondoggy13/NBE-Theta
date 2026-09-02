/**
 * Polymarket CLOB adapter.
 *
 * **Refuses to construct without all three live flags.** See
 * `config.ts` for why the check is at construction rather than at
 * submit.
 *
 * ## Why the signing client is injected rather than imported
 *
 * ADR-0002 §"Adopted": use Polymarket's supported CLOB
 * authentication/signing model rather than hand-rolling EIP-712.
 * Hand-rolled order signing is a footgun — a wrong domain separator or
 * field ordering produces a signature the venue rejects at best, and
 * signs something other than what you meant at worst.
 *
 * So this adapter takes a `ClobSigningClient` and never builds one. The
 * concrete wiring to `@polymarket/clob-client` belongs with the live
 * capability gate, for two reasons:
 *
 *   1. Nothing here can be verified against the real venue from CI — the
 *      venue hosts are unreachable, and AGENTS.md forbids a test that
 *      places a real order regardless.
 *   2. An adapter that *looks* wired but has never round-tripped a
 *      signature is more dangerous than one that is obviously not, since
 *      it invites trusting it.
 *
 * Everything with logic in it — races, idempotency, reconciliation,
 * buying power — lives in the coordinator and simulator, which are fully
 * tested. What remains here is the wire call.
 */

import type {
  CancelFilter,
  CancelResult,
  ExecutionReport,
  FillPage,
  OrderBook,
  OrderIntent,
  OutcomeInstrument,
  PredictionMarketVenue,
  Subscription,
  UserEventHandler,
  VenueAccountState,
  VenueOrder,
  VenuePosition,
} from "@nbe-theta/execution-domain";
import { assertLiveAllowed, type EnvLike, type LiveGate } from "../config.js";

/**
 * The surface we need from the official client. Kept minimal so the real
 * one can be adapted to it without this file knowing about ethers,
 * wallets, or signature encoding.
 */
export interface ClobSigningClient {
  postOrder(args: {
    tokenId: string;
    side: "BUY" | "SELL";
    size: string;
    price: string;
    timeInForce: string;
    clientOrderId: string;
    expiresAt?: string;
  }): Promise<{ orderId: string; status: string; filledSize?: string; avgPrice?: string }>;
  cancelOrder(orderId: string): Promise<void>;
  cancelAll(filter?: CancelFilter): Promise<{ canceled: string[] }>;
  openOrders(): Promise<VenueOrder[]>;
  positions(): Promise<VenuePosition[]>;
  fills(cursor?: string): Promise<FillPage>;
  book(tokenId: string): Promise<{ bids: { price: string; size: string }[]; asks: { price: string; size: string }[] }>;
  balance(): Promise<{ available: string; reserved: string }>;
  subscribeUser(handler: UserEventHandler): Promise<Subscription>;
}

export class PolymarketClobVenue implements PredictionMarketVenue {
  readonly gate: LiveGate;

  constructor(
    private readonly client: ClobSigningClient,
    private readonly accountId: string,
    env: EnvLike = process.env,
  ) {
    // Throws unless all three flags are present. Construction is the
    // gate.
    this.gate = assertLiveAllowed(env);
  }

  async getAccountState(): Promise<VenueAccountState> {
    const b = await this.client.balance();
    return { accountId: this.accountId, availableCash: b.available, reservedCash: b.reserved };
  }

  async getMarketBook(instrument: OutcomeInstrument): Promise<OrderBook> {
    const b = await this.client.book(instrument.outcomeTokenId);
    return { instrument, bids: b.bids, asks: b.asks, observedAt: new Date().toISOString() };
  }

  async submitIntent(intent: OrderIntent): Promise<ExecutionReport> {
    try {
      const res = await this.client.postOrder({
        tokenId: intent.instrument.outcomeTokenId,
        side: intent.side,
        size: intent.quantity,
        price: intent.limitPrice,
        timeInForce: intent.timeInForce,
        clientOrderId: intent.clientIntentId,
        expiresAt: intent.expiresAt,
      });
      return {
        clientIntentId: intent.clientIntentId,
        venueOrderId: res.orderId,
        status: mapStatus(res.status),
        filledQuantity: res.filledSize ?? "0",
        avgPrice: res.avgPrice ?? null,
        feesPaid: "0",
        observedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Any thrown error here is AMBIGUOUS: the order may be resting on
      // the venue. Reporting `rejected` would invite a retry and double
      // the exposure — `unknown` forces the coordinator to reconcile,
      // which is the only safe response.
      return {
        clientIntentId: intent.clientIntentId,
        venueOrderId: null,
        status: "unknown",
        filledQuantity: "0",
        avgPrice: null,
        feesPaid: "0",
        reason: err instanceof Error ? err.message : "submit failed",
        observedAt: new Date().toISOString(),
      };
    }
  }

  cancelOrder(venueOrderId: string): Promise<void> {
    return this.client.cancelOrder(venueOrderId);
  }

  async cancelAll(filter?: CancelFilter): Promise<CancelResult> {
    const res = await this.client.cancelAll(filter);
    return { canceled: res.canceled, failed: [] };
  }

  listOpenOrders(): Promise<VenueOrder[]> {
    return this.client.openOrders();
  }

  listPositions(): Promise<VenuePosition[]> {
    return this.client.positions();
  }

  listRecentFills(cursor?: string): Promise<FillPage> {
    return this.client.fills(cursor);
  }

  subscribeUserEvents(handler: UserEventHandler): Promise<Subscription> {
    return this.client.subscribeUser(handler);
  }
}

function mapStatus(raw: string): ExecutionReport["status"] {
  switch (raw.toLowerCase()) {
    case "matched":
    case "filled":
      return "filled";
    case "live":
    case "open":
      return "live";
    case "partial":
    case "partially_filled":
      return "partially_filled";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "rejected":
      return "rejected";
    default:
      // An unrecognised status is NOT a success. We do not know what the
      // venue did, and treating an unknown string as "live" would leave
      // an order we never reconcile.
      return "unknown";
  }
}
