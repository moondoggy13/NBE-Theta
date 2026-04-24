import { describe, expect, it } from "vitest";
import { MockBrokerClient } from "../mock";

describe("MockBrokerClient", () => {
  it("refuses orders before a reference price is set", async () => {
    const b = new MockBrokerClient({ startEquity: 10_000 });
    await expect(
      b.submitOrder({ symbol: "BTC-USD", side: "buy", type: "market", qty: 1 }),
    ).rejects.toThrow();
  });

  it("fills a round trip and accounts for realized P&L", async () => {
    const b = new MockBrokerClient({ startEquity: 10_000, slippageBps: 0, feeBps: 0 });
    b.setReferencePrice(100);
    await b.submitOrder({ symbol: "BTC-USD", side: "buy", type: "market", qty: 1 });
    b.setReferencePrice(110);
    await b.submitOrder({ symbol: "BTC-USD", side: "sell", type: "market", qty: 1 });
    const acct = await b.getAccount();
    expect(acct.equity).toBeCloseTo(10_010, 6);
    expect((await b.getPositions()).length).toBe(0);
  });

  it("applies slippage and fees", async () => {
    const b = new MockBrokerClient({ startEquity: 10_000, slippageBps: 10, feeBps: 10 });
    b.setReferencePrice(100);
    const o = await b.submitOrder({ symbol: "BTC-USD", side: "buy", type: "market", qty: 1 });
    expect(o.filledPrice).toBeCloseTo(100.1, 5);
    expect(o.fees).toBeGreaterThan(0);
  });

  it("notifies the fill handler", async () => {
    const b = new MockBrokerClient({ startEquity: 10_000 });
    b.setReferencePrice(100);
    const seen: unknown[] = [];
    b.onFill((f) => seen.push(f));
    await b.submitOrder({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.5 });
    expect(seen.length).toBe(1);
  });
});
