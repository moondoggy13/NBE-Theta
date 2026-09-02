/**
 * CLOB simulator.
 *
 * ## Why this enforces buying power
 *
 * The v2 incident's root cause, from CLAUDE.md, was four things
 * together: *sync check + async submit + shared mutable state + **a mock
 * broker with no buying-power enforcement***.
 *
 * That last clause is the one that turns a race into a $29k loss. With
 * a permissive mock, four concurrent orders all "succeed" and the test
 * suite is green; the position only becomes impossible in production,
 * against a venue that actually checks. A simulator that lets you
 * overspend cannot catch the bug it exists to catch — so this one
 * refuses an order it cannot fund, exactly as the venue would.
 *
 * ## Deliberate pessimism
 *
 * - **Walks the book.** Price is the VWAP of levels actually consumed,
 *   never the top. Filling size at the best price is the most common way
 *   a simulator manufactures returns.
 * - **FOK is all-or-nothing.** A partial is a rejection.
 * - **Depth is consumed.** Two orders in the same tick do not both get
 *   the same liquidity — that is precisely the race being tested.
 * - **Configurable latency and failure injection**, so the caller can
 *   force the `unknown` outcome that reconciliation exists for.
 */

import type {
  CancelFilter,
  CancelResult,
  ExecutionReport,
  FillPage,
  OrderBook,
  OrderBookLevel,
  OrderIntent,
  OutcomeInstrument,
  PredictionMarketVenue,
  Subscription,
  UserEvent,
  UserEventHandler,
  VenueAccountState,
  VenueFill,
  VenueOrder,
  VenuePosition,
} from "@nbe-theta/execution-domain";
import { instrumentKey } from "@nbe-theta/execution-domain";

export interface SimulatorConfig {
  accountId?: string;
  startingCash?: number;
  feeRate?: number;
  /** Artificial round-trip delay. The window in which races happen. */
  latencyMs?: number;
  /**
   * Force the next N submits to resolve as `unknown` — submitted, outcome
   * unobservable. The state reconciliation exists to repair.
   */
  ambiguousSubmits?: number;
}

interface SimOrder extends VenueOrder {
  createdAt: number;
}

const ZERO = "0";

function n(v: string): number {
  return Number(v);
}

export class ClobSimulator implements PredictionMarketVenue {
  readonly accountId: string;
  private cash: number;
  private reserved = 0;
  private readonly feeRate: number;
  private readonly latencyMs: number;
  private ambiguousRemaining: number;

  private readonly books = new Map<string, { bids: OrderBookLevel[]; asks: OrderBookLevel[] }>();
  private readonly orders = new Map<string, SimOrder>();
  private readonly positions = new Map<string, { instrument: OutcomeInstrument; qty: number; cost: number }>();
  private readonly fills: VenueFill[] = [];
  private readonly handlers = new Set<UserEventHandler>();
  private seq = 0;

  /** Every submit ever seen, including duplicates. The duplicate-exposure
   * tests assert on this rather than on order count, because a venue
   * receiving two submits is the failure even if it dedupes them. */
  readonly submitLog: string[] = [];

  constructor(config: SimulatorConfig = {}) {
    this.accountId = config.accountId ?? "sim-account";
    this.cash = config.startingCash ?? 100_000;
    this.feeRate = config.feeRate ?? 0.02;
    this.latencyMs = config.latencyMs ?? 0;
    this.ambiguousRemaining = config.ambiguousSubmits ?? 0;
  }

  // ── setup ─────────────────────────────────────────────────────────

  setBook(instrument: OutcomeInstrument, bids: OrderBookLevel[], asks: OrderBookLevel[]): void {
    this.books.set(instrumentKey(this.accountId, instrument), {
      bids: [...bids].sort((a, b) => n(b.price) - n(a.price)),
      asks: [...asks].sort((a, b) => n(a.price) - n(b.price)),
    });
  }

  get availableCash(): number {
    return this.cash;
  }

  positionQty(instrument: OutcomeInstrument): number {
    return this.positions.get(instrumentKey(this.accountId, instrument))?.qty ?? 0;
  }

  // ── venue interface ───────────────────────────────────────────────

  async getAccountState(): Promise<VenueAccountState> {
    await this.delay();
    return {
      accountId: this.accountId,
      availableCash: String(this.cash),
      reservedCash: String(this.reserved),
    };
  }

  async getMarketBook(instrument: OutcomeInstrument): Promise<OrderBook> {
    await this.delay();
    const b = this.books.get(instrumentKey(this.accountId, instrument));
    return {
      instrument,
      bids: b?.bids ?? [],
      asks: b?.asks ?? [],
      observedAt: new Date().toISOString(),
    };
  }

  async submitIntent(intent: OrderIntent): Promise<ExecutionReport> {
    // Logged BEFORE the await, so a duplicate submit is recorded even if
    // the response never arrives. Counting only completed submits would
    // hide exactly the double-send we are testing for.
    this.submitLog.push(intent.clientIntentId);

    await this.delay();

    if (this.ambiguousRemaining > 0) {
      this.ambiguousRemaining -= 1;
      // Submitted; outcome unobservable. The order may or may not be
      // resting on the venue — which is why the caller must reconcile
      // rather than retry.
      return {
        clientIntentId: intent.clientIntentId,
        venueOrderId: null,
        status: "unknown",
        filledQuantity: ZERO,
        avgPrice: null,
        feesPaid: ZERO,
        reason: "timeout before acknowledgement",
        observedAt: new Date().toISOString(),
      };
    }

    const key = instrumentKey(this.accountId, intent.instrument);
    const book = this.books.get(key);
    const wanted = n(intent.quantity);
    const limit = n(intent.limitPrice);

    if (!book || wanted <= 0) {
      return this.reject(intent, "no book");
    }

    const levels = intent.side === "BUY" ? book.asks : book.bids;
    const takeable = levels.filter((l) =>
      intent.side === "BUY" ? n(l.price) <= limit : n(l.price) >= limit,
    );
    const available = takeable.reduce((a, l) => a + n(l.size), 0);

    if (available <= 0) return this.reject(intent, "limit_exceeded");
    if (intent.timeInForce === "FOK" && available < wanted) {
      return this.reject(intent, "insufficient_depth");
    }

    const fillQty = Math.min(wanted, available);

    // Walk the book for a VWAP.
    let remaining = fillQty;
    let cost = 0;
    const consumed: { level: OrderBookLevel; qty: number }[] = [];
    for (const level of takeable) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, n(level.size));
      cost += take * n(level.price);
      remaining -= take;
      consumed.push({ level, qty: take });
    }
    const vwap = cost / fillQty;
    const fee = cost * this.feeRate;

    // ── Buying power. The check whose absence made v2 expensive. ─────
    if (intent.side === "BUY" && cost + fee > this.cash) {
      return this.reject(intent, "insufficient_buying_power");
    }
    if (intent.side === "SELL") {
      const held = this.positions.get(key)?.qty ?? 0;
      if (fillQty > held) {
        // The strategy never opens shorts; a sell beyond inventory is a
        // bug upstream, and the venue is where it must stop.
        return this.reject(intent, "insufficient_inventory");
      }
    }

    // Consume depth so a second order in the same tick cannot take the
    // same liquidity. Without this the simulator would happily fill four
    // racing orders from one book.
    for (const { level, qty } of consumed) {
      const idx = levels.indexOf(level);
      if (idx >= 0) {
        const left = n(level.size) - qty;
        if (left <= 0) levels.splice(idx, 1);
        else levels[idx] = { price: level.price, size: String(left) };
      }
    }

    const venueOrderId = `sim-${++this.seq}`;
    const status = fillQty >= wanted ? "filled" : "partially_filled";

    if (intent.side === "BUY") {
      this.cash -= cost + fee;
      const pos = this.positions.get(key) ?? { instrument: intent.instrument, qty: 0, cost: 0 };
      pos.qty += fillQty;
      pos.cost += cost;
      this.positions.set(key, pos);
    } else {
      this.cash += cost - fee;
      const pos = this.positions.get(key) ?? { instrument: intent.instrument, qty: 0, cost: 0 };
      pos.qty -= fillQty;
      this.positions.set(key, pos);
    }

    const order: SimOrder = {
      venueOrderId,
      clientIntentId: intent.clientIntentId,
      instrument: intent.instrument,
      side: intent.side,
      quantity: intent.quantity,
      limitPrice: intent.limitPrice,
      timeInForce: intent.timeInForce,
      status,
      filledQuantity: String(fillQty),
      createdAt: Date.now(),
    };
    this.orders.set(venueOrderId, order);

    const fill: VenueFill = {
      venueOrderId,
      instrument: intent.instrument,
      side: intent.side,
      quantity: String(fillQty),
      price: String(vwap),
      fee: String(fee),
      occurredAt: new Date().toISOString(),
    };
    this.fills.push(fill);
    this.emit({ kind: "order", order });
    this.emit({ kind: "fill", fill });

    return {
      clientIntentId: intent.clientIntentId,
      venueOrderId,
      status,
      filledQuantity: String(fillQty),
      avgPrice: String(vwap),
      feesPaid: String(fee),
      observedAt: new Date().toISOString(),
    };
  }

  async cancelOrder(venueOrderId: string): Promise<void> {
    await this.delay();
    const o = this.orders.get(venueOrderId);
    if (o && (o.status === "live" || o.status === "partially_filled")) {
      o.status = "canceled";
      this.emit({ kind: "order", order: o });
    }
  }

  async cancelAll(filter?: CancelFilter): Promise<CancelResult> {
    await this.delay();
    const canceled: string[] = [];
    for (const o of this.orders.values()) {
      if (o.status !== "live" && o.status !== "partially_filled") continue;
      if (filter?.conditionId && o.instrument.conditionId !== filter.conditionId) continue;
      if (filter?.outcomeTokenId && o.instrument.outcomeTokenId !== filter.outcomeTokenId) continue;
      o.status = "canceled";
      canceled.push(o.venueOrderId);
      this.emit({ kind: "order", order: o });
    }
    return { canceled, failed: [] };
  }

  async listOpenOrders(): Promise<VenueOrder[]> {
    await this.delay();
    return [...this.orders.values()].filter(
      (o) => o.status === "live" || o.status === "partially_filled",
    );
  }

  async listPositions(): Promise<VenuePosition[]> {
    await this.delay();
    return [...this.positions.values()]
      .filter((p) => p.qty !== 0)
      .map((p) => ({
        instrument: p.instrument,
        quantity: String(p.qty),
        avgPrice: p.qty > 0 ? String(p.cost / p.qty) : null,
      }));
  }

  async listRecentFills(): Promise<FillPage> {
    await this.delay();
    return { fills: [...this.fills], cursor: null };
  }

  async subscribeUserEvents(handler: UserEventHandler): Promise<Subscription> {
    this.handlers.add(handler);
    return {
      close: () => {
        this.handlers.delete(handler);
      },
    };
  }

  /** Orders the venue holds, for reconciliation tests. */
  ordersByIntent(clientIntentId: string): VenueOrder[] {
    return [...this.orders.values()].filter((o) => o.clientIntentId === clientIntentId);
  }

  // ── internals ─────────────────────────────────────────────────────

  private reject(intent: OrderIntent, reason: string): ExecutionReport {
    return {
      clientIntentId: intent.clientIntentId,
      venueOrderId: null,
      status: "rejected",
      filledQuantity: ZERO,
      avgPrice: null,
      feesPaid: ZERO,
      reason,
      observedAt: new Date().toISOString(),
    };
  }

  private emit(event: UserEvent): void {
    for (const h of this.handlers) h(event);
  }

  private async delay(): Promise<void> {
    if (this.latencyMs <= 0) {
      // Still yield: a zero-latency await is what lets a concurrent
      // caller interleave, and it is the interleaving the race tests
      // depend on.
      await Promise.resolve();
      return;
    }
    await new Promise((r) => setTimeout(r, this.latencyMs));
  }
}
