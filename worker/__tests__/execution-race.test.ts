import { describe, expect, it, vi } from "vitest";
import { ExecutionManager } from "../execution";
import { MockBrokerClient } from "../../src/lib/broker/mock";
import { PRESETS } from "../../src/lib/risk/config";
import { makeInitialRiskState, type RiskState } from "../../src/lib/risk/kill-switch";
import type { AppEnv } from "../lib/env";

const fakeLogger = {
  info:  vi.fn(),
  warn:  vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  flush: vi.fn(),
} as unknown as ConstructorParameters<typeof ExecutionManager>[0]["logger"];

const fakeEnv: AppEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  COINBASE_MODE: "paper",
  COINBASE_LIVE: "false",
  CONFIRM_LIVE: "NO",
  FLATTEN_ON_EXIT: "false",
  RISK_PRESET: "Aggressive",
  SYMBOL: "BTC-USD",
} as unknown as AppEnv;

function makeManager() {
  const broker = new MockBrokerClient({ startEquity: 25_000, slippageBps: 0, feeBps: 0, maxLeverage: 1.0 });
  broker.setReferencePrice(78_000);
  let state: RiskState = makeInitialRiskState({ startEquity: 25_000, autonomousExecution: true });
  const exec = new ExecutionManager({
    env: fakeEnv,
    cfg: PRESETS.Aggressive,
    symbol: "BTC-USD",
    broker,
    logger: fakeLogger,
    getRiskState: () => state,
    setRiskState: (patch) => { state = { ...state, ...patch }; },
    execCfg: { cooldownMs: 0 }, // disable cooldown for this test
  });
  return { broker, exec };
}

describe("ExecutionManager race condition", () => {
  it("does NOT submit duplicate close orders when 4 ticks fire in the same ms", async () => {
    const { broker, exec } = makeManager();

    // Open a long position manually (bypass the entry path for this test).
    await broker.submitOrder({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.3 });
    // Force ExecutionManager into "long" with stop just under price.
    // Use a small reflective hack — set internal state via a contrived
    // decision so onPriceUpdate has something to close.
    (exec as unknown as { lastSide: string; currentStop: number }).lastSide = "long";
    (exec as unknown as { lastSide: string; currentStop: number }).currentStop = 78_500;

    // Move price ABOVE stop; oh wait stop is HIGHER than price for long means
    // long stops are usually below entry. Use 77_000 instead.
    (exec as unknown as { currentStop: number }).currentStop = 77_000;
    broker.setReferencePrice(76_999); // below stop → trigger

    const submitSpy = vi.spyOn(broker, "submitOrder");
    submitSpy.mockClear();

    // Fire 4 onPriceUpdate calls "concurrently" — start them all before any await resolves.
    const promises = [
      exec.onPriceUpdate(76_999),
      exec.onPriceUpdate(76_998),
      exec.onPriceUpdate(76_997),
      exec.onPriceUpdate(76_996),
    ];
    await Promise.all(promises);

    // Only ONE close order should have been submitted.
    const closeCalls = submitSpy.mock.calls.filter(
      ([req]) => req.metadata?.reason === "stop" || req.side === "sell",
    );
    expect(closeCalls.length).toBe(1);

    // Position should be flat.
    const positions = await broker.getPositions();
    expect(positions.length).toBe(0);
  });

  it("reconcile() detects and flattens a phantom position", async () => {
    const { broker, exec } = makeManager();
    // Sneak a position into the broker that ExecutionManager doesn't know about.
    await broker.submitOrder({ symbol: "BTC-USD", side: "buy", type: "market", qty: 0.2 });
    expect((await broker.getPositions()).length).toBe(1);

    // ExecutionManager thinks we're flat (we never told it).
    expect((exec as unknown as { lastSide: string }).lastSide).toBe("flat");

    await exec.reconcile();

    // Position should be closed by reconcile.
    expect((await broker.getPositions()).length).toBe(0);
  });
});
