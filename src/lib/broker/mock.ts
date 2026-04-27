/**
 * Mock broker for backtests + paper trading.
 *
 * Fills synchronously at the most recently observed reference price
 * (+/- slippage). The worker feeds this client via `setReferencePrice`
 * every time a new tick or candle arrives.
 */
import { randomUUID } from "node:crypto";
import type {
  Account,
  BrokerClient,
  Fill,
  Order,
  OrderRequest,
  PositionView,
} from "./types";

export interface MockBrokerOptions {
  startEquity: number;
  slippageBps?: number;
  feeBps?: number;
  /**
   * Maximum notional exposure as a multiple of equity. 1.0 = spot reality
   * (you can't buy more BTC than you have USD for). Higher values simulate
   * margin / perpetuals. The catastrophic 57x runaway long that motivated
   * this guard would have been impossible at any realistic leverage.
   */
  maxLeverage?: number;
}

export class MockBrokerClient implements BrokerClient {
  readonly mode = "paper" as const;
  readonly name = "mock";

  private equity: number;
  private position: { symbol: string; qty: number; avgEntry: number; realized: number } = {
    symbol: "BTC-USD",
    qty: 0,
    avgEntry: 0,
    realized: 0,
  };
  private refPrice = NaN;
  private fillHandler?: (fill: Fill, order: Order) => void;
  private slip: number;
  private fee: number;
  private readonly maxLeverage: number;
  private orders = new Map<string, Order>();

  constructor(opts: MockBrokerOptions) {
    this.equity = opts.startEquity;
    this.slip = (opts.slippageBps ?? 1) / 10_000;
    this.fee = (opts.feeBps ?? 5) / 10_000;
    this.maxLeverage = Math.max(1, opts.maxLeverage ?? 1);
  }

  setReferencePrice(price: number): void {
    if (price > 0) this.refPrice = price;
  }

  async submitOrder(req: OrderRequest): Promise<Order> {
    if (!Number.isFinite(this.refPrice)) {
      throw new Error("MockBroker has no reference price yet; call setReferencePrice first");
    }
    const id = randomUUID();
    const fillPrice =
      req.side === "buy" ? this.refPrice * (1 + this.slip) : this.refPrice * (1 - this.slip);
    const now = Date.now();
    const fees = req.qty * fillPrice * this.fee;

    // Buying-power / leverage guard. Mirrors real-spot reality: an order
    // that GROWS the absolute notional position must have backing equity.
    // Closing or reducing positions never gets blocked.
    const currentNotional = Math.abs(this.position.qty) * (this.position.avgEntry || fillPrice);
    const wouldGrow =
      (req.side === "buy" && this.position.qty >= 0) ||
      (req.side === "sell" && this.position.qty <= 0);
    if (wouldGrow) {
      const newNotional = currentNotional + req.qty * fillPrice;
      const cap = (this.equity + this.position.realized) * this.maxLeverage;
      if (newNotional > cap) {
        const reason = `notional $${newNotional.toFixed(2)} exceeds buying power $${cap.toFixed(2)} (maxLeverage ${this.maxLeverage}x)`;
        const rejected: Order = {
          id,
          mode: "paper",
          symbol: req.symbol,
          side: req.side,
          type: req.type,
          qty: req.qty,
          price: req.price,
          status: "rejected",
          submittedAt: now,
          filledQty: 0,
          fees: 0,
          strategyId: req.strategyId,
          metadata: { ...req.metadata, rejectReason: reason },
        };
        this.orders.set(id, rejected);
        throw new Error(`MockBroker: ${reason}`);
      }
    }

    const order: Order = {
      id,
      mode: "paper",
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: req.qty,
      price: req.price,
      status: "filled",
      submittedAt: now,
      filledAt: now,
      filledQty: req.qty,
      filledPrice: fillPrice,
      fees,
      strategyId: req.strategyId,
      metadata: req.metadata,
    };
    this.orders.set(id, order);

    // Update position
    if (req.side === "buy") {
      const newQty = this.position.qty + req.qty;
      if (this.position.qty >= 0) {
        // extending / opening long
        this.position.avgEntry =
          (this.position.avgEntry * this.position.qty + fillPrice * req.qty) / newQty;
      } else {
        // covering short
        const coverQty = Math.min(-this.position.qty, req.qty);
        this.position.realized += (this.position.avgEntry - fillPrice) * coverQty;
      }
      this.position.qty = newQty;
    } else {
      const newQty = this.position.qty - req.qty;
      if (this.position.qty <= 0) {
        // extending / opening short
        const avgBase = -this.position.qty;
        this.position.avgEntry =
          (this.position.avgEntry * avgBase + fillPrice * req.qty) / (avgBase + req.qty);
      } else {
        // closing long
        const closeQty = Math.min(this.position.qty, req.qty);
        this.position.realized += (fillPrice - this.position.avgEntry) * closeQty;
      }
      this.position.qty = newQty;
    }
    // Flat?
    if (this.position.qty === 0) this.position.avgEntry = 0;

    this.equity -= fees;
    // realized P&L is already counted in position; the mock treats it as cash
    // for downstream reporting by folding it back in on getAccount().

    const fill: Fill = {
      orderId: id,
      ts: now,
      price: fillPrice,
      qty: req.qty,
      liquidity: "taker",
      fee: fees,
    };
    if (this.fillHandler) this.fillHandler(fill, order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const o = this.orders.get(orderId);
    if (o && o.status !== "filled") o.status = "canceled";
  }

  async getAccount(): Promise<Account> {
    const unreal =
      Number.isFinite(this.refPrice) && this.position.qty !== 0
        ? (this.refPrice - this.position.avgEntry) * this.position.qty
        : 0;
    return {
      equity: this.equity + this.position.realized + unreal,
      buyingPower: this.equity + this.position.realized,
      currency: "USD",
    };
  }

  async getPositions(): Promise<PositionView[]> {
    if (this.position.qty === 0) return [];
    const unreal = Number.isFinite(this.refPrice)
      ? (this.refPrice - this.position.avgEntry) * this.position.qty
      : 0;
    return [
      {
        symbol: this.position.symbol,
        qty: this.position.qty,
        avgEntry: this.position.avgEntry,
        unrealizedPnl: unreal,
        realizedPnl: this.position.realized,
      },
    ];
  }

  onFill(handler: (fill: Fill, order: Order) => void): void {
    this.fillHandler = handler;
  }
}
