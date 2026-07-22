import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests the auth gate on POST /api/kill-switch.
 *
 * The gate rules:
 *   - NODE_ENV != production → bypass (dev UX unchanged).
 *   - NODE_ENV == production && !CONTROL_API_TOKEN → 503.
 *   - NODE_ENV == production && bad or missing bearer → 401.
 *   - NODE_ENV == production && matching bearer → passes auth (the
 *     downstream 503 for "supabase not configured" in tests is expected;
 *     we assert on the auth outcome, not the DB path).
 */

// Stub the Supabase client so the route doesn't try to reach a real DB.
vi.mock("@/lib/supabase/client", () => ({ serverClient: () => null }));

let POST: (req: Request) => Promise<Response>;

async function loadRoute() {
  vi.resetModules();
  const mod = await import("../route");
  POST = mod.POST;
}

// We mutate NODE_ENV + CONTROL_API_TOKEN in these tests. Snapshot both,
// and restore them each test so the file is order-independent and does
// not leak into other suites.
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

function reqWithHeader(auth?: string): Request {
  return new Request("http://localhost/api/kill-switch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify({ active: true }),
  });
}

describe("POST /api/kill-switch auth gate", () => {
  it("bypasses auth in development", async () => {
    env.NODE_ENV = "development";
    await loadRoute();
    const r = await POST(reqWithHeader());
    // No auth check → falls through to supabase path (mocked to null → 503).
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason?: string };
    expect(body.reason).toBe("supabase not configured");
  });

  it("returns 503 in production when CONTROL_API_TOKEN is unset", async () => {
    env.NODE_ENV = "production";
    delete env.CONTROL_API_TOKEN;
    await loadRoute();
    const r = await POST(reqWithHeader("Bearer anything"));
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason?: string };
    expect(body.reason).toMatch(/control api token not configured/);
  });

  it("returns 503 in production when CONTROL_API_TOKEN is too short", async () => {
    env.NODE_ENV = "production";
    env.CONTROL_API_TOKEN = "short";
    await loadRoute();
    const r = await POST(reqWithHeader("Bearer short"));
    expect(r.status).toBe(503);
  });

  it("returns 401 in production without a bearer token", async () => {
    env.NODE_ENV = "production";
    env.CONTROL_API_TOKEN = "x".repeat(32);
    await loadRoute();
    const r = await POST(reqWithHeader());
    expect(r.status).toBe(401);
  });

  it("returns 401 in production with a wrong bearer token", async () => {
    env.NODE_ENV = "production";
    env.CONTROL_API_TOKEN = "x".repeat(32);
    await loadRoute();
    const r = await POST(reqWithHeader("Bearer y".repeat(1) + "x".repeat(31)));
    expect(r.status).toBe(401);
  });

  it("passes auth in production with matching bearer (then hits supabase 503)", async () => {
    env.NODE_ENV = "production";
    env.CONTROL_API_TOKEN = "x".repeat(32);
    await loadRoute();
    const r = await POST(reqWithHeader(`Bearer ${"x".repeat(32)}`));
    // Auth passed; supabase mock → 503 not 401.
    expect(r.status).toBe(503);
    const body = (await r.json()) as { reason?: string };
    expect(body.reason).toBe("supabase not configured");
  });
});
