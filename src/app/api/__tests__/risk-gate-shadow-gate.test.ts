import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Risk-gate regression test (AGENTS.md: any change to a risk gate needs
 * an ADR, a `risk-gate-*` test, and review by someone other than the
 * author). The ADR is `docs/adr/0003-shadow-gate-enforcement.md`.
 *
 * The gate: `/api/console/mode` refuses to promote to 'live' unless a
 * `shadow_gate_runs` row with verdict 'pass' exists.
 *
 * Before PR 11 this condition was a comment in the route's docstring.
 * That is the weakest possible form for it, because skipping the shadow
 * period does not *look* like disabling a safety check — it looks like
 * impatience, and there was nothing to say no. These tests exist so that
 * deleting the check breaks the build rather than the account.
 *
 * The most important case is `insufficient_evidence`: a recorded packet
 * that could not be judged must not authorise anything. A check written
 * as "is there a gate run?" instead of "is there a *passing* gate run?"
 * passes every other test in this file and fails that one.
 */

const KEYS = [
  "NODE_ENV",
  "CONTROL_API_TOKEN",
  "CONTROL_API_TOKEN_ROLE",
  "EXECUTION_PROVIDER",
  "POLYMARKET_LIVE",
  "CONFIRM_LIVE",
] as const;
const original: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
for (const k of KEYS) original[k] = env[k];

const TOKEN = "test-token-at-least-16-chars";

interface GateRun {
  id: string;
  evaluated_at: string;
  window_start: string;
  window_end: string;
  verdict: string;
}

/** Rows the fake database will return, per test. */
const db: { gateRuns: GateRun[]; gateQueryFails: boolean; inserted: unknown[] } = {
  gateRuns: [],
  gateQueryFails: false,
  inserted: [],
};

/**
 * A chainable Supabase stub. Only the shapes the route actually uses.
 *
 * `shadow_gate_runs` reads filter on verdict here rather than returning
 * whatever was seeded, so a route that forgot the `.eq("verdict",
 * "pass")` filter would see the unfiltered rows — which is exactly the
 * bug the `insufficient_evidence` case below is looking for.
 */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        order: () => builder,
        update: () => builder,
        insert: (row: unknown) => {
          db.inserted.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        limit: () => {
          if (table === "shadow_gate_runs") {
            if (db.gateQueryFails) {
              // Rows AND an error together. A stub that returned
              // `data: null` here would let a route with no error check
              // pass this test anyway — the `data ?? []` fallback would
              // do the refusing, and the check under test would never
              // run. Returning both forces the route to actually prefer
              // the error over the payload.
              return Promise.resolve({ data: db.gateRuns, error: { message: "db down" } });
            }
            const rows = db.gateRuns.filter(
              (r) => filters.verdict === undefined || r.verdict === filters.verdict,
            );
            return Promise.resolve({ data: rows, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        single: () =>
          Promise.resolve({
            data: { id: 1, mode: "shadow", kill_switch_active: false },
            error: null,
          }),
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/client", () => ({ serverClient: () => fakeClient() }));

beforeEach(() => {
  for (const k of KEYS) delete env[k];
  env.CONTROL_API_TOKEN = TOKEN;
  // PR 12 caps the shared token at 'operator' by default, and promotion
  // to live requires 'admin'. That role rule is exercised in
  // risk-gate-operator-roles.test.ts; here it is lifted so this file
  // keeps testing the SHADOW GATE in isolation. A test where two
  // conditions block cannot tell you which one did.
  env.CONTROL_API_TOKEN_ROLE = "admin";
  // The three-flag env gate satisfied too, for the same reason.
  env.EXECUTION_PROVIDER = "polymarket-clob";
  env.POLYMARKET_LIVE = "true";
  env.CONFIRM_LIVE = "YES";
  db.gateRuns = [];
  db.gateQueryFails = false;
  db.inserted = [];
});
afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete env[k];
    else env[k] = original[k];
  }
});

const PASSING: GateRun = {
  id: "run-pass-1",
  evaluated_at: "2027-06-01T00:00:00Z",
  window_start: "2027-05-01T00:00:00Z",
  window_end: "2027-06-01T00:00:00Z",
  verdict: "pass",
};

function post(body: unknown): Request {
  return new Request("http://localhost/api/console/mode", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function loadRoute() {
  vi.resetModules();
  return (await import("../console/mode/route")) as {
    GET: (r: Request) => Promise<Response>;
    POST: (r: Request) => Promise<Response>;
  };
}

describe("risk gate: live mode requires a passing shadow-gate run", () => {
  it("refuses live when no gate run has ever been recorded", async () => {
    const mod = await loadRoute();
    const res = await mod.POST(post({ mode: "live", confirm: "ENABLE-LIVE" }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; reason: string };
    expect(json.ok).toBe(false);
    expect(json.reason).toMatch(/shadow-gate/i);
  });

  it("refuses live when the only recorded packet is insufficient_evidence", async () => {
    // The case the whole three-state design exists for. An empty shadow
    // window satisfies "zero duplicate orders" and "zero unresolved
    // incidents" trivially; a packet recording that is not permission.
    db.gateRuns = [{ ...PASSING, id: "run-insufficient", verdict: "insufficient_evidence" }];
    const mod = await loadRoute();
    const res = await mod.POST(post({ mode: "live", confirm: "ENABLE-LIVE" }));
    expect(res.status).toBe(409);
  });

  it("refuses live when the recorded packet failed", async () => {
    db.gateRuns = [{ ...PASSING, id: "run-fail", verdict: "fail" }];
    const mod = await loadRoute();
    const res = await mod.POST(post({ mode: "live", confirm: "ENABLE-LIVE" }));
    expect(res.status).toBe(409);
  });

  it("refuses live when the gate query errors, even if rows came back", async () => {
    // A database that cannot answer "has the gate passed?" has not
    // answered "yes". Treating an error as permission would make an
    // outage the cheapest route to live trading — and a response that
    // carries an error is not evidence, whatever else is attached to it.
    db.gateQueryFails = true;
    db.gateRuns = [PASSING];
    const mod = await loadRoute();
    const res = await mod.POST(post({ mode: "live", confirm: "ENABLE-LIVE" }));
    expect(res.status).toBe(409);
  });

  it("allows live once a passing packet exists", async () => {
    db.gateRuns = [PASSING];
    const mod = await loadRoute();
    const res = await mod.POST(post({ mode: "live", confirm: "ENABLE-LIVE" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; shadowGate: { passed: boolean } };
    expect(json.ok).toBe(true);
    expect(json.shadowGate.passed).toBe(true);
  });

  it("records which packet authorised the promotion", async () => {
    // "The gate passed" is not auditable six months later. The run id
    // and its window are.
    db.gateRuns = [PASSING];
    const mod = await loadRoute();
    await mod.POST(post({ mode: "live", confirm: "ENABLE-LIVE", actor: "founder" }));
    const audit = db.inserted.find(
      (i) => (i as { table: string }).table === "operator_actions",
    ) as { row: { action: string; detail: { shadowGateRun: { id: string } | null } } } | undefined;
    expect(audit?.row.action).toBe("mode_change");
    expect(audit?.row.detail.shadowGateRun?.id).toBe("run-pass-1");
  });

  it("still requires the two-step confirmation, gate or no gate", async () => {
    // The gate check must not have replaced the confirmation check.
    db.gateRuns = [PASSING];
    const mod = await loadRoute();
    const res = await mod.POST(post({ mode: "live" }));
    expect(res.status).toBe(400);
  });

  it("still requires the three-flag env gate, gate or no gate", async () => {
    db.gateRuns = [PASSING];
    env.POLYMARKET_LIVE = "false";
    const mod = await loadRoute();
    const res = await mod.POST(post({ mode: "live", confirm: "ENABLE-LIVE" }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toMatch(/env gate/i);
  });
});

describe("shadow and paused are not gated by the shadow gate", () => {
  // Shadow mode is how the evidence gets collected in the first place.
  // Requiring a passing gate to enter it would be a deadlock, and
  // requiring one to PAUSE would be worse: it would mean a system in
  // trouble could not be stopped.
  for (const mode of ["shadow", "paused"] as const) {
    it(`allows ${mode} with no gate run at all`, async () => {
      const mod = await loadRoute();
      const res = await mod.POST(post({ mode }));
      expect(res.status).toBe(200);
    });
  }
});

describe("GET reports the gate status so the console can explain itself", () => {
  it("reports passed:false when nothing has passed", async () => {
    const mod = await loadRoute();
    const res = await mod.GET(
      new Request("http://localhost/api/console/mode", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    const json = (await res.json()) as { shadowGate: { passed: boolean } };
    expect(json.shadowGate.passed).toBe(false);
  });

  it("reports the passing run when there is one", async () => {
    db.gateRuns = [PASSING];
    const mod = await loadRoute();
    const res = await mod.GET(
      new Request("http://localhost/api/console/mode", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    const json = (await res.json()) as { shadowGate: { passed: boolean; run: { id: string } } };
    expect(json.shadowGate.passed).toBe(true);
    expect(json.shadowGate.run.id).toBe("run-pass-1");
  });
});
