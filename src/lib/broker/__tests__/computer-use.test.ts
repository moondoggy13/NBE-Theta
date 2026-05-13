import { describe, expect, it, vi } from "vitest";
import {
  ComputerUseBrokerClient,
  type CUEventStream,
  type HostFillEvent,
} from "../computer-use";

const baseOpts = {
  hostUrl: "http://127.0.0.1:7331",
  hostToken: "tok",
  symbol: "AAPL",
  liveEnabled: true,
  dryRun: true,
  maxNotionalUsd: 1000,
};

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = handler(url, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function fakeStream(): CUEventStream & {
  emitFill(msg: HostFillEvent): void;
} {
  const handlers: { fill: Array<(m: HostFillEvent) => void> } = { fill: [] };
  return {
    on(event, h) {
      if (event === "fill") handlers.fill.push(h as (m: HostFillEvent) => void);
    },
    close() {},
    emitFill(msg) {
      handlers.fill.forEach((h) => h(msg));
    },
  };
}

describe("ComputerUseBrokerClient", () => {
  it("refuses construction when live gate is off", () => {
    expect(() => new ComputerUseBrokerClient({ ...baseOpts, liveEnabled: false })).toThrow(
      /gates not set/,
    );
  });

  it("refuses construction when host url or token is missing", () => {
    expect(
      () => new ComputerUseBrokerClient({ ...baseOpts, hostUrl: "", hostToken: "" }),
    ).toThrow(/hostUrl and hostToken/);
  });

  it("requires a positive notional cap", () => {
    expect(() => new ComputerUseBrokerClient({ ...baseOpts, maxNotionalUsd: 0 })).toThrow(
      /maxNotionalUsd/,
    );
  });

  it("rejects orders that exceed the local notional cap before dispatch", async () => {
    const fetchImpl = vi.fn(mockFetch(() => ({ ok: true, taskId: "t1" })));
    const c = new ComputerUseBrokerClient({
      ...baseOpts,
      maxNotionalUsd: 100,
      fetchImpl,
      wsFactory: () => fakeStream(),
    });
    await expect(
      c.submitOrder({ symbol: "AAPL", side: "buy", type: "limit", qty: 1, price: 500 }),
    ).rejects.toThrow(/exceeds cap/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a structured order envelope to /orders", async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fetchImpl = mockFetch((url, init) => {
      captured = { url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      return { ok: true, taskId: "t-123", status: "submitted" };
    });
    const c = new ComputerUseBrokerClient({
      ...baseOpts,
      fetchImpl,
      wsFactory: () => fakeStream(),
    });
    const order = await c.submitOrder({
      clientOrderId: "co-1",
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      qty: 1,
      price: 100,
    });
    expect(captured?.url).toBe("http://127.0.0.1:7331/orders");
    expect(captured?.body).toMatchObject({
      clientOrderId: "co-1",
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      price: 100,
      dryRun: true,
    });
    expect(order.brokerOrderId).toBe("t-123");
    expect(order.status).toBe("submitted");
  });

  it("is idempotent on clientOrderId — a duplicate submit returns the cached order", async () => {
    const fetchImpl = vi.fn(mockFetch(() => ({ ok: true, taskId: "t-once" })));
    const c = new ComputerUseBrokerClient({
      ...baseOpts,
      fetchImpl,
      wsFactory: () => fakeStream(),
    });
    const req = { clientOrderId: "dup", symbol: "AAPL", side: "buy", type: "market", qty: 1 } as const;
    const a = await c.submitOrder(req);
    const b = await c.submitOrder(req);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("relays WS fill events into the onFill handler", async () => {
    const stream = fakeStream();
    const fetchImpl = mockFetch(() => ({ ok: true, taskId: "t-x", status: "submitted" }));
    const c = new ComputerUseBrokerClient({
      ...baseOpts,
      fetchImpl,
      wsFactory: () => stream,
    });
    const fills: Array<{ price: number; qty: number }> = [];
    c.onFill((f) => fills.push({ price: f.price, qty: f.qty }));
    await c.submitOrder({
      clientOrderId: "co-fill",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      qty: 2,
    });
    stream.emitFill({
      type: "fill",
      clientOrderId: "co-fill",
      hostTaskId: "t-x",
      ts: Date.now(),
      price: 100,
      qty: 2,
    });
    expect(fills).toEqual([{ price: 100, qty: 2 }]);
  });
});
