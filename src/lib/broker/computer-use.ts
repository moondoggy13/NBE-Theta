/**
 * Computer-Use broker client.
 *
 * Does NOT touch any exchange API. Forwards a structured OrderRequest to a
 * local "agent-host" process running on the trading workstation. The host
 * is the only thing with OS-level input access — it drives Webull desktop
 * via Claude or OpenAI computer-use under a constrained skill set, verifies
 * fills by OCR/accessibility, and streams Fill events back over WebSocket.
 *
 * Why a separate process at all:
 *   - the worker may run in a container / on a different box than the
 *     trading PC where Webull is open and logged in;
 *   - credentials and 2FA stay on the trading PC, never in this repo;
 *   - swapping driver (Claude ↔ OpenAI) is a one-line agent-host change.
 *
 * Safety invariants enforced HERE (before anything reaches the LLM):
 *   1) three-gate live enable (mirrors Coinbase two-gate pattern + CU gate);
 *   2) per-order notional cap (MAX_NOTIONAL_USD) — fast local reject;
 *   3) idempotent submit keyed on clientOrderId — duplicate suppression in
 *      case the worker retries while a slow click-loop is mid-flight.
 */
import { randomUUID } from "node:crypto";
import type {
  Account,
  BrokerClient,
  Fill,
  Order,
  OrderRequest,
  OrderStatus,
  PositionView,
} from "./types";

export interface ComputerUseBrokerOptions {
  hostUrl: string;
  hostToken: string;
  symbol: string;
  /** External flag confirming the three computer-use gates are set. */
  liveEnabled: boolean;
  /** When true the host fills the ticket but never clicks Submit. */
  dryRun: boolean;
  /** Per-order notional cap in USD. Rejected synchronously before dispatch. */
  maxNotionalUsd: number;
  /** Optional fetch impl for tests. */
  fetchImpl?: typeof fetch;
  /** Optional WebSocket factory for tests. */
  wsFactory?: (url: string, token: string) => CUEventStream;
}

/** Minimal WS-like interface the client needs. Tests inject a fake. */
export interface CUEventStream {
  on(event: "fill", handler: (msg: HostFillEvent) => void): void;
  on(event: "status", handler: (msg: HostStatusEvent) => void): void;
  on(event: "close", handler: () => void): void;
  close(): void;
}

export interface HostFillEvent {
  type: "fill";
  clientOrderId: string;
  hostTaskId: string;
  ts: number;
  price: number;
  qty: number;
  fee?: number;
  liquidity?: "maker" | "taker";
}

export interface HostStatusEvent {
  type: "status";
  clientOrderId: string;
  status: OrderStatus;
  reason?: string;
}

export class ComputerUseBrokerClient implements BrokerClient {
  readonly mode = "live" as const;
  readonly name = "computer-use-webull";

  private readonly symbol: string;
  private readonly hostUrl: string;
  private readonly hostToken: string;
  private readonly dryRun: boolean;
  private readonly maxNotional: number;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string, token: string) => CUEventStream;

  private fillHandler?: (fill: Fill, order: Order) => void;
  /** clientOrderId -> Order. Used for idempotent submit + WS fill correlation. */
  private readonly orders = new Map<string, Order>();
  private stream?: CUEventStream;

  constructor(opts: ComputerUseBrokerOptions) {
    if (!opts.liveEnabled) {
      throw new Error(
        "Refusing to construct ComputerUseBrokerClient: gates not set (need EXECUTION_PROVIDER=computer-use && COMPUTER_USE_LIVE=true && CONFIRM_LIVE=YES)",
      );
    }
    if (!opts.hostUrl || !opts.hostToken) {
      throw new Error("ComputerUseBrokerClient requires hostUrl and hostToken");
    }
    if (!(opts.maxNotionalUsd > 0)) {
      throw new Error("ComputerUseBrokerClient requires a positive maxNotionalUsd cap");
    }
    this.symbol = opts.symbol;
    this.hostUrl = opts.hostUrl.replace(/\/+$/, "");
    this.hostToken = opts.hostToken;
    this.dryRun = opts.dryRun;
    this.maxNotional = opts.maxNotionalUsd;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
  }

  async submitOrder(req: OrderRequest): Promise<Order> {
    const clientOrderId = req.clientOrderId ?? randomUUID();

    // Idempotency: a retry with the same clientOrderId returns the existing
    // record. The host applies the same rule on its side; both must agree.
    const existing = this.orders.get(clientOrderId);
    if (existing) return existing;

    // Synchronous notional cap. The LLM never sees orders that would breach.
    const refPrice = req.price ?? req.stopPrice;
    if (refPrice !== undefined) {
      const notional = Math.abs(req.qty * refPrice);
      if (notional > this.maxNotional) {
        throw new Error(
          `ComputerUseBroker: notional $${notional.toFixed(2)} exceeds cap $${this.maxNotional.toFixed(2)}`,
        );
      }
    }
    // For market orders we have no price; the host is responsible for
    // re-checking notional against the live ticker before clicking Submit.

    const now = Date.now();
    const order: Order = {
      id: clientOrderId,
      mode: "live",
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: req.qty,
      price: req.price,
      status: "pending",
      submittedAt: now,
      filledQty: 0,
      fees: 0,
      strategyId: req.strategyId,
      metadata: { ...req.metadata, dryRun: this.dryRun },
    };
    this.orders.set(clientOrderId, order);

    const res = await this.postJson<{
      ok: boolean;
      taskId?: string;
      status?: OrderStatus;
      reason?: string;
    }>("/orders", {
      clientOrderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: req.qty,
      price: req.price,
      stopPrice: req.stopPrice,
      dryRun: this.dryRun,
      metadata: req.metadata,
    });

    if (!res.ok || !res.taskId) {
      order.status = "rejected";
      order.metadata = { ...order.metadata, rejectReason: res.reason ?? "host rejected" };
      throw new Error(`ComputerUseBroker host rejected order: ${res.reason ?? "unknown"}`);
    }

    order.brokerOrderId = res.taskId;
    order.status = res.status ?? "submitted";
    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.postJson(`/orders/${encodeURIComponent(orderId)}/cancel`, {});
    const o = this.orders.get(orderId);
    if (o && o.status !== "filled") o.status = "canceled";
  }

  async getAccount(): Promise<Account> {
    return this.getJson<Account>("/account");
  }

  async getPositions(): Promise<PositionView[]> {
    return this.getJson<PositionView[]>("/positions");
  }

  onFill(handler: (fill: Fill, order: Order) => void): void {
    this.fillHandler = handler;
    if (!this.stream) this.connectStream();
  }

  /** Test seam: surface the host's healthcheck so execution can gate on it. */
  async healthcheck(): Promise<{ ok: boolean; details?: unknown }> {
    try {
      const r = await this.fetchImpl(`${this.hostUrl}/healthz`, {
        headers: { authorization: `Bearer ${this.hostToken}` },
      });
      if (!r.ok) return { ok: false, details: await safeText(r) };
      return { ok: true, details: await r.json().catch(() => ({})) };
    } catch (err) {
      return { ok: false, details: String(err) };
    }
  }

  close(): void {
    this.stream?.close();
    this.stream = undefined;
  }

  private connectStream(): void {
    const url = this.hostUrl.replace(/^http/, "ws") + "/events";
    const stream = this.wsFactory(url, this.hostToken);
    stream.on("fill", (msg) => {
      const order = this.orders.get(msg.clientOrderId);
      if (!order) return;
      const remaining = order.qty - order.filledQty;
      const fillQty = Math.min(msg.qty, remaining);
      order.filledQty += fillQty;
      order.filledPrice = msg.price;
      order.filledAt = msg.ts;
      order.fees += msg.fee ?? 0;
      order.status = order.filledQty >= order.qty ? "filled" : "partial";
      const fill: Fill = {
        orderId: order.id,
        ts: msg.ts,
        price: msg.price,
        qty: fillQty,
        liquidity: msg.liquidity,
        fee: msg.fee ?? 0,
      };
      this.fillHandler?.(fill, order);
    });
    stream.on("status", (msg) => {
      const order = this.orders.get(msg.clientOrderId);
      if (!order) return;
      order.status = msg.status;
      if (msg.reason) order.metadata = { ...order.metadata, rejectReason: msg.reason };
    });
    stream.on("close", () => {
      this.stream = undefined;
    });
    this.stream = stream;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const r = await this.fetchImpl(`${this.hostUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.hostToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error(`agent-host ${path} ${r.status}: ${await safeText(r)}`);
    }
    return (await r.json()) as T;
  }

  private async getJson<T>(path: string): Promise<T> {
    const r = await this.fetchImpl(`${this.hostUrl}${path}`, {
      headers: { authorization: `Bearer ${this.hostToken}` },
    });
    if (!r.ok) {
      throw new Error(`agent-host ${path} ${r.status}: ${await safeText(r)}`);
    }
    return (await r.json()) as T;
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "<unreadable>";
  }
}

function defaultWsFactory(url: string, token: string): CUEventStream {
  type WSCtor = new (u: string, p?: string | string[], o?: unknown) => unknown;
  const g = globalThis as unknown as { WebSocket?: WSCtor };
  if (!g.WebSocket) {
    throw new Error(
      "No global WebSocket available; pass wsFactory or run under Node 22+ / a WS polyfill",
    );
  }
  type WSLike = {
    addEventListener(ev: string, cb: (e: { data?: unknown }) => void): void;
    close(): void;
  };
  const sock = new g.WebSocket(url, undefined, {
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as WSLike;
  const fillHandlers: Array<(m: HostFillEvent) => void> = [];
  const statusHandlers: Array<(m: HostStatusEvent) => void> = [];
  const closeHandlers: Array<() => void> = [];
  sock.addEventListener("message", (e) => {
    try {
      const raw = typeof e.data === "string" ? e.data : "";
      const msg = JSON.parse(raw) as HostFillEvent | HostStatusEvent;
      if (msg.type === "fill") fillHandlers.forEach((h) => h(msg));
      else if (msg.type === "status") statusHandlers.forEach((h) => h(msg));
    } catch {
      // ignore malformed frames; host should not be sending them
    }
  });
  sock.addEventListener("close", () => closeHandlers.forEach((h) => h()));
  return {
    on(event, handler) {
      if (event === "fill") fillHandlers.push(handler as (m: HostFillEvent) => void);
      else if (event === "status") statusHandlers.push(handler as (m: HostStatusEvent) => void);
      else if (event === "close") closeHandlers.push(handler as () => void);
    },
    close() {
      sock.close();
    },
  };
}
