import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for a live data exposure.
 *
 * Four routes read tables that are on the RLS deny-list — `wallets`,
 * `wallet_watchlist`, `wallet_positions`, `venue_trades`,
 * `leaderboard_snapshots`, `wallet_candidates` — using the Supabase
 * *service-role* key, which bypasses RLS entirely. They had no auth
 * check on GET, so those rows were reachable by anyone who knew the URL.
 * One of them even carried the docstring "Service-role only (deny-anon
 * source tables)" above a handler that checked nothing.
 *
 * The deny-list and the route gate are two halves of one control:
 * migrations stop the *browser* reading those tables, this stops a
 * *route* handing over the same rows. Either half alone is not a
 * boundary, so this test asserts the second half exists on every route
 * that touches the first.
 *
 * `/api/markets` and `/api/health` are deliberately excluded: they serve
 * public venue data and `risk_state`, both anon-readable by design.
 */

vi.mock("@/lib/supabase/client", () => ({ serverClient: () => null }));

const KEYS = ["NODE_ENV", "CONTROL_API_TOKEN"] as const;
const original: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
for (const k of KEYS) original[k] = env[k];

beforeEach(() => {
  for (const k of KEYS) delete env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete env[k];
    else env[k] = original[k];
  }
});

const TOKEN = "test-token-at-least-16-chars";

/** Every route whose source tables are on the RLS deny-list. */
const GUARDED_GETS = [
  ["smart-money/leaders", () => import("../smart-money/leaders/route")],
  ["smart-money/flows", () => import("../smart-money/flows/route")],
  ["smart-money/tape", () => import("../smart-money/tape/route")],
  ["watchlist", () => import("../watchlist/route")],
  ["console/signals", () => import("../console/signals/route")],
  ["console/cohort", () => import("../console/cohort/route")],
  ["console/portfolio", () => import("../console/portfolio/route")],
  ["console/health", () => import("../console/health/route")],
  ["console/mode", () => import("../console/mode/route")],
  ["console/gate", () => import("../console/gate/route")],
] as const;

function get(path: string, auth?: string): Request {
  return new Request(`http://localhost/api/${path}`, {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("routes reading deny-list tables require an operator token", () => {
  for (const [name, load] of GUARDED_GETS) {
    describe(name, () => {
      it("rejects an unauthenticated GET in production", async () => {
        env.NODE_ENV = "production";
        env.CONTROL_API_TOKEN = TOKEN;
        vi.resetModules();
        const mod = (await load()) as { GET: (r: Request) => Promise<Response> };
        const res = await mod.GET(get(name));
        expect(res.status).toBe(401);
      });

      it("rejects a wrong bearer token", async () => {
        env.NODE_ENV = "production";
        env.CONTROL_API_TOKEN = TOKEN;
        vi.resetModules();
        const mod = (await load()) as { GET: (r: Request) => Promise<Response> };
        const res = await mod.GET(get(name, "Bearer not-the-right-token-x"));
        expect(res.status).toBe(401);
      });

      it("fails closed with 503 when no token is configured in production", async () => {
        // A misconfigured deployment must refuse, not fall open. This is
        // the exact failure mode the fix exists to prevent.
        env.NODE_ENV = "production";
        vi.resetModules();
        const mod = (await load()) as { GET: (r: Request) => Promise<Response> };
        const res = await mod.GET(get(name));
        expect(res.status).toBe(503);
      });

      it("passes auth with the right bearer token", async () => {
        env.NODE_ENV = "production";
        env.CONTROL_API_TOKEN = TOKEN;
        vi.resetModules();
        const mod = (await load()) as { GET: (r: Request) => Promise<Response> };
        const res = await mod.GET(get(name, `Bearer ${TOKEN}`));
        // Supabase is stubbed to null, so the route gets past auth and
        // then reports it cannot reach the DB. Anything but 401/503-for-
        // auth means the gate let us through, which is what we assert.
        expect(res.status).not.toBe(401);
      });
    });
  }
});

describe("public routes stay open", () => {
  it("GET /api/markets needs no token — it serves public venue data", async () => {
    env.NODE_ENV = "production";
    env.CONTROL_API_TOKEN = TOKEN;
    vi.resetModules();
    const mod = await import("../markets/route");
    const res = await mod.GET(get("markets"));
    expect(res.status).not.toBe(401);
  });
});
