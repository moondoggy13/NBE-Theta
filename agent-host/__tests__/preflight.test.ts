import { describe, expect, it } from "vitest";
import { preflight } from "../safety/preflight";
import type { SubmitOrderBody } from "../protocol";
import type { TicketSnapshot } from "../webull/skills";

const baseOrder: SubmitOrderBody = {
  clientOrderId: "co-1",
  symbol: "AAPL",
  side: "buy",
  type: "limit",
  qty: 1,
  price: 100,
  dryRun: true,
};
const baseTicket: TicketSnapshot = {
  symbol: "AAPL",
  side: "buy",
  type: "limit",
  qty: 1,
  price: 100,
  estNotionalUsd: 100,
  submitEnabled: true,
};

describe("preflight", () => {
  it("passes when ticket matches order and window is ready", () => {
    expect(
      preflight({
        order: baseOrder,
        ticket: baseTicket,
        maxNotionalUsd: 1_000,
        windowReady: true,
      }),
    ).toBeNull();
  });

  it("blocks when window is not ready", () => {
    expect(
      preflight({
        order: baseOrder,
        ticket: baseTicket,
        maxNotionalUsd: 1_000,
        windowReady: false,
      }),
    ).toMatch(/window not ready/);
  });

  it("blocks on symbol mismatch", () => {
    expect(
      preflight({
        order: baseOrder,
        ticket: { ...baseTicket, symbol: "MSFT" },
        maxNotionalUsd: 1_000,
        windowReady: true,
      }),
    ).toMatch(/symbol mismatch/);
  });

  it("blocks on qty mismatch", () => {
    expect(
      preflight({
        order: baseOrder,
        ticket: { ...baseTicket, qty: 2 },
        maxNotionalUsd: 1_000,
        windowReady: true,
      }),
    ).toMatch(/qty mismatch/);
  });

  it("blocks when estimated notional exceeds cap", () => {
    expect(
      preflight({
        order: baseOrder,
        ticket: baseTicket,
        maxNotionalUsd: 50,
        windowReady: true,
      }),
    ).toMatch(/exceeds cap/);
  });

  it("blocks on account mismatch when expected label is set", () => {
    expect(
      preflight({
        order: baseOrder,
        ticket: baseTicket,
        maxNotionalUsd: 1_000,
        windowReady: true,
        expectedAccountLabel: "Paper",
        observedAccountLabel: "Margin",
      }),
    ).toMatch(/wrong account/);
  });
});
