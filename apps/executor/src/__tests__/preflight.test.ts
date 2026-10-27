/**
 * Preflight tests.
 *
 * The point of these is the *verdict arithmetic*, not the prose. A
 * preflight that reports "connected" when a probe failed to run is
 * worse than no preflight, because it converts an unknown into a
 * reassurance — the same failure mode ADR-0003 describes for a
 * two-valued gate over an empty window.
 */

import { describe, expect, it } from "vitest";
import {
  exitCode,
  formatReport,
  runPreflight,
  type Connect,
  type PreflightTarget,
} from "../preflight.js";

const KEY = `0x${"ab".repeat(32)}`;
const SIGNER = `0x${"22".repeat(20)}`;
const PROXY = `0x${"11".repeat(20)}`;

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SIGNER_PRIVATE_KEY: KEY,
    POLYMARKET_SIGNATURE_TYPE: "poly-proxy",
    POLYMARKET_FUNDER_ADDRESS: PROXY,
    ...over,
  };
}

function target(over: Partial<PreflightTarget> = {}): PreflightTarget {
  return {
    signerAddress: SIGNER,
    accountId: PROXY,
    apiCredentialsDerived: true,
    collateral: () => Promise.resolve({ balance: "250.5", allowance: "1000000" }),
    listOpenOrders: () => Promise.resolve([]),
    ...over,
  };
}

const connecting =
  (t: PreflightTarget = target()): Connect =>
  () =>
    Promise.resolve(t);

function check(report: Awaited<ReturnType<typeof runPreflight>>, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name} in ${report.checks.map((c) => c.name)}`);
  return found;
}

describe("a correctly configured proxied account", () => {
  it("reports connected", async () => {
    const report = await runPreflight(connecting(), env());
    expect(report.verdict).toBe("connected");
    expect(report.accountId).toBe(PROXY);
    expect(report.signerAddress).toBe(SIGNER);
    expect(exitCode(report)).toBe(0);
  });

  it("reports the live gate separately and does not require it", async () => {
    // Preflight must be runnable BEFORE arming live, or an operator has
    // to arm live trading to discover whether their key works.
    const report = await runPreflight(connecting(), env());
    expect(report.verdict).toBe("connected");
    expect(report.liveGate.satisfied).toBe(false);
    expect(formatReport(report)).toContain("live gate: not armed");
  });

  it("acknowledges an armed gate when all three flags are present", async () => {
    const report = await runPreflight(
      connecting(),
      env({
        EXECUTION_PROVIDER: "polymarket-clob",
        POLYMARKET_LIVE: "true",
        CONFIRM_LIVE: "YES",
      }),
    );
    expect(report.liveGate.satisfied).toBe(true);
    expect(formatReport(report)).toContain("live gate: ARMED");
  });
});

describe("verdict precedence", () => {
  it("a check that could not run blocks 'connected' rather than passing", async () => {
    const report = await runPreflight(
      connecting(target({ collateral: () => Promise.reject(new Error("venue 503")) })),
      env(),
    );
    expect(check(report, "collateral").state).toBe("unknown");
    expect(report.verdict).toBe("incomplete");
    expect(exitCode(report)).toBe(1);
  });

  it("a failure outranks an unknown", async () => {
    const report = await runPreflight(
      connecting(
        target({
          collateral: () => Promise.reject(new Error("venue 503")),
          listOpenOrders: () => Promise.reject(new Error("401 unauthorized")),
        }),
      ),
      env(),
    );
    expect(check(report, "l2_authentication").state).toBe("fail");
    expect(check(report, "collateral").state).toBe("unknown");
    expect(report.verdict).toBe("blocked");
  });
});

describe("account identity", () => {
  it("fails when a proxied scheme points at the signer's own address", async () => {
    // The consequential misconfiguration: valid signatures, wrong
    // account, no money.
    const report = await runPreflight(
      connecting(target({ accountId: SIGNER })),
      env({ POLYMARKET_FUNDER_ADDRESS: SIGNER }),
    );
    expect(check(report, "account_identity").state).toBe("fail");
    expect(check(report, "account_identity").remedy).toMatch(/deposit address/);
    expect(report.verdict).toBe("blocked");
  });

  it("fails when eoa is declared but a different funder is configured", async () => {
    const report = await runPreflight(
      connecting(target({ accountId: PROXY })),
      env({ POLYMARKET_SIGNATURE_TYPE: "eoa" }),
    );
    expect(check(report, "account_identity").state).toBe("fail");
    expect(report.verdict).toBe("blocked");
  });

  it("passes for a plain eoa trading its own balance", async () => {
    const report = await runPreflight(
      connecting(target({ accountId: SIGNER })),
      env({ POLYMARKET_SIGNATURE_TYPE: "eoa", POLYMARKET_FUNDER_ADDRESS: undefined }),
    );
    expect(check(report, "account_identity").state).toBe("ok");
    expect(report.verdict).toBe("connected");
  });
});

describe("collateral and allowance", () => {
  it("fails an unfunded account and names the deposit address", async () => {
    const report = await runPreflight(
      connecting(target({ collateral: () => Promise.resolve({ balance: "0", allowance: "1" }) })),
      env(),
    );
    expect(check(report, "collateral_funded").state).toBe("fail");
    expect(check(report, "collateral_funded").remedy).toContain(PROXY);
  });

  it("fails a funded account the exchange cannot spend from", async () => {
    // Holds money, cannot trade. The venue reports this as a rejected
    // order, which is why it has to be caught here instead.
    const report = await runPreflight(
      connecting(target({ collateral: () => Promise.resolve({ balance: "500", allowance: "0" }) })),
      env(),
    );
    expect(check(report, "collateral_allowance").state).toBe("fail");
    expect(report.verdict).toBe("blocked");
  });

  it("flags a partial allowance as unknown, not as a pass", async () => {
    // It trades until the allowance is exhausted, then starts refusing
    // mid-session — which looks like an outage.
    const report = await runPreflight(
      connecting(
        target({ collateral: () => Promise.resolve({ balance: "500", allowance: "100" }) }),
      ),
      env(),
    );
    expect(check(report, "collateral_allowance").state).toBe("unknown");
    expect(report.verdict).toBe("incomplete");
  });

  it("treats unparseable amounts as unmeasured, never as zero", async () => {
    // "unmeasured" and "no money" are different claims (the same rule
    // CLAUDE.md states for clv/markout_*).
    const report = await runPreflight(
      connecting(
        target({ collateral: () => Promise.resolve({ balance: "n/a", allowance: "n/a" }) }),
      ),
      env(),
    );
    expect(check(report, "collateral").state).toBe("unknown");
    expect(report.checks.some((c) => c.name === "collateral_funded")).toBe(false);
  });
});

describe("hard failures", () => {
  it("reports a credential problem without attempting to connect", async () => {
    let connectCalled = false;
    const report = await runPreflight(
      () => {
        connectCalled = true;
        return Promise.resolve(target());
      },
      env({ POLYMARKET_SIGNATURE_TYPE: undefined }),
    );
    expect(connectCalled).toBe(false);
    expect(report.verdict).toBe("blocked");
    expect(check(report, "credentials_resolved").state).toBe("fail");
    expect(report.configuration).toBeNull();
  });

  it("stops at a failed handshake rather than reporting later checks as passed", async () => {
    const report = await runPreflight(() => Promise.reject(new Error("L1 refused")), env());
    expect(report.verdict).toBe("blocked");
    expect(check(report, "venue_handshake").state).toBe("fail");
    expect(report.checks.some((c) => c.name === "l2_authentication")).toBe(false);
    expect(report.accountId).toBeNull();
  });

  it("never puts key material in the rendered report", async () => {
    const report = await runPreflight(connecting(), env());
    const rendered = formatReport(report);
    expect(rendered).not.toContain("ab".repeat(32));
    expect(JSON.stringify(report)).not.toContain("ab".repeat(32));
  });
});
