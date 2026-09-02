import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Risk-gate regression test for operator identity and roles
 * (AGENTS.md: an auth-boundary change needs an ADR, a `risk-gate-*`
 * test, and review by someone other than the author).
 * The ADR is `docs/adr/0004-operator-identity.md`.
 *
 * Three properties, in descending order of how much damage losing them
 * would do:
 *
 * 1. **A valid Supabase login is not authorisation.** Anyone who can
 *    sign up to the project would otherwise become an operator. The
 *    `operator_accounts` row is the grant; the session only proves who
 *    is asking.
 * 2. **The audit actor cannot be chosen by the caller.** Before PR 12
 *    `/api/console/mode` read `actor` from the request body, so a
 *    token-holder could record a mode change under any name they liked.
 * 3. **The shared token cannot arm live trading.** It is a transitional
 *    credential held by more people than it should be and tied to no
 *    person; promotion to live requires a named `admin`.
 *
 * Everything here also asserts the module fails CLOSED. A gate that
 * turns an outage into an authorisation is worse than no gate, because
 * it is the one failure mode nobody is watching for.
 */

const KEYS = [
  "NODE_ENV",
  "CONTROL_API_TOKEN",
  "CONTROL_API_TOKEN_ROLE",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "EXECUTION_PROVIDER",
  "POLYMARKET_LIVE",
  "CONFIRM_LIVE",
] as const;
const original: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
for (const k of KEYS) original[k] = env[k];

const TOKEN = "test-token-at-least-16-chars";
const SESSION = "supabase-session-jwt";

interface Account {
  role?: string;
  active?: boolean;
  email?: string | null;
}

const db: {
  user: { id: string; email: string } | null;
  userError: boolean;
  userThrows: boolean;
  account: Account | null;
  accountError: boolean;
  inserted: { table: string; row: Record<string, unknown> }[];
  gatePasses: boolean;
} = {
  user: null,
  userError: false,
  userThrows: false,
  account: null,
  accountError: false,
  inserted: [],
  gatePasses: true,
};

function fakeClient() {
  return {
    auth: {
      // The JWT is not inspected: this stub decides validity from `db`,
      // because what is under test is how the route reacts to each
      // verdict, not how Supabase reaches one.
      getUser: () => {
        if (db.userThrows) return Promise.reject(new Error("auth server unreachable"));
        if (db.userError || !db.user) {
          return Promise.resolve({ data: null, error: { message: "bad jwt" } });
        }
        return Promise.resolve({ data: { user: db.user }, error: null });
      },
    },
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        lt: () => builder,
        order: () => builder,
        update: () => builder,
        insert: (row: Record<string, unknown>) => {
          db.inserted.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        limit: () => {
          if (table === "operator_accounts") {
            if (db.accountError) {
              return Promise.resolve({ data: null, error: { message: "db down" } });
            }
            return Promise.resolve({ data: db.account ? [db.account] : [], error: null });
          }
          if (table === "shadow_gate_runs") {
            return Promise.resolve({
              data: db.gatePasses
                ? [
                    {
                      id: "run-1",
                      evaluated_at: "2027-06-01T00:00:00Z",
                      window_start: "2027-05-01T00:00:00Z",
                      window_end: "2027-06-01T00:00:00Z",
                    },
                  ]
                : [],
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        },
        single: () =>
          Promise.resolve({ data: { id: 1, mode: "shadow" }, error: null }),
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/client", () => ({ serverClient: () => fakeClient() }));

beforeEach(() => {
  for (const k of KEYS) delete env[k];
  env.NODE_ENV = "production";
  env.SUPABASE_URL = "https://example.supabase.co";
  env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  db.user = { id: "user-1", email: "operator@example.com" };
  db.userError = false;
  db.userThrows = false;
  db.account = { role: "operator", active: true, email: "operator@example.com" };
  db.accountError = false;
  db.inserted = [];
  db.gatePasses = true;
});
afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete env[k];
    else env[k] = original[k];
  }
});

function req(path: string, auth?: string, body?: unknown): Request {
  return new Request(`http://localhost/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(auth ? { authorization: auth } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function load(path: string) {
  vi.resetModules();
  return (await import(`../${path}/route`)) as {
    GET?: (r: Request) => Promise<Response>;
    POST?: (r: Request) => Promise<Response>;
  };
}

describe("a Supabase session is authentication, not authorisation", () => {
  it("refuses a verified user with no operator_accounts row", async () => {
    // The property that matters most. Without it, anyone who can sign up
    // to the Supabase project is an operator.
    db.account = null;
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toMatch(/no operator account/i);
  });

  it("refuses a deactivated account", async () => {
    db.account = { role: "admin", active: false };
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(403);
  });

  it("refuses an account whose role is not one we recognise", async () => {
    // A typo or a hand-edited row must not become a wildcard.
    db.account = { role: "superuser", active: true };
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(403);
  });

  it("admits a verified user who does have an account", async () => {
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(200);
  });

  it("refuses an unverifiable session", async () => {
    db.userError = true;
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(401);
  });
});

describe("fails closed when it cannot tell", () => {
  it("returns 503, never 200, when the account lookup errors", async () => {
    // An outage must not be a way in. 503 rather than 403 so the failure
    // is legible as an outage instead of hiding among permission denials.
    db.accountError = true;
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(503);
  });

  it("returns 503 when the auth server is unreachable", async () => {
    db.userThrows = true;
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(503);
  });

  it("refuses everything when no mechanism is configured at all", async () => {
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", "Bearer anything"));
    expect(res.status).toBe(503);
  });
});

describe("roles are enforced per route", () => {
  it("a viewer may read the console", async () => {
    db.account = { role: "viewer", active: true };
    const mod = await load("console/signals");
    const res = await mod.GET!(req("console/signals", `Bearer ${SESSION}`));
    expect(res.status).toBe(200);
  });

  it("a viewer may NOT change the watchlist", async () => {
    db.account = { role: "viewer", active: true };
    const mod = await load("watchlist");
    const res = await mod.POST!(
      req("watchlist", `Bearer ${SESSION}`, {
        wallet: "0x1234567890123456789012345678901234567890",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("a viewer may NOT touch the kill switch", async () => {
    db.account = { role: "viewer", active: true };
    const mod = await load("kill-switch");
    const res = await mod.POST!(req("kill-switch", `Bearer ${SESSION}`, { active: true }));
    expect(res.status).toBe(403);
  });

  it("an operator may touch the kill switch", async () => {
    db.account = { role: "operator", active: true };
    const mod = await load("kill-switch");
    const res = await mod.POST!(req("kill-switch", `Bearer ${SESSION}`, { active: true }));
    expect(res.status).toBe(200);
  });

  it("an admin satisfies a requirement for operator", async () => {
    // The hierarchy is ascending: a higher role satisfies a lower bar.
    db.account = { role: "admin", active: true };
    const mod = await load("kill-switch");
    const res = await mod.POST!(req("kill-switch", `Bearer ${SESSION}`, { active: true }));
    expect(res.status).toBe(200);
  });
});

describe("only an admin can arm live trading", () => {
  beforeEach(() => {
    env.EXECUTION_PROVIDER = "polymarket-clob";
    env.POLYMARKET_LIVE = "true";
    env.CONFIRM_LIVE = "YES";
  });

  it("an operator is refused, even with every other condition met", async () => {
    db.account = { role: "operator", active: true };
    const mod = await load("console/mode");
    const res = await mod.POST!(
      req("console/mode", `Bearer ${SESSION}`, { mode: "live", confirm: "ENABLE-LIVE" }),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toMatch(/admin/i);
  });

  it("an operator may still move to shadow and paused", async () => {
    // Least privilege must not become a lockout: the person who can stop
    // trading should not need the person who can start it.
    db.account = { role: "operator", active: true };
    const mod = await load("console/mode");
    for (const mode of ["shadow", "paused"]) {
      const res = await mod.POST!(req("console/mode", `Bearer ${SESSION}`, { mode }));
      expect(res.status).toBe(200);
    }
  });

  it("an admin may arm live", async () => {
    db.account = { role: "admin", active: true };
    const mod = await load("console/mode");
    const res = await mod.POST!(
      req("console/mode", `Bearer ${SESSION}`, { mode: "live", confirm: "ENABLE-LIVE" }),
    );
    expect(res.status).toBe(200);
  });

  it("the shared token cannot arm live at its default role", async () => {
    // The token is held by more people than it should be and is tied to
    // no person. Arming real money requires a named human.
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    env.CONTROL_API_TOKEN = TOKEN;
    const mod = await load("console/mode");
    const res = await mod.POST!(
      req("console/mode", `Bearer ${TOKEN}`, { mode: "live", confirm: "ENABLE-LIVE" }),
    );
    expect(res.status).toBe(403);
  });

  it("the shared token can still run the kill switch", async () => {
    // The transition must not disarm the emergency stop.
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    env.CONTROL_API_TOKEN = TOKEN;
    const mod = await load("kill-switch");
    const res = await mod.POST!(req("kill-switch", `Bearer ${TOKEN}`, { active: true }));
    expect(res.status).toBe(200);
  });
});

describe("the audit actor comes from the server, not the caller", () => {
  it("ignores an actor supplied in the request body", async () => {
    // The bug this replaces: /api/console/mode read `actor` from the
    // body, so the audited party wrote their own log entry.
    db.account = { role: "admin", active: true, email: "real@example.com" };
    const mod = await load("console/mode");
    await mod.POST!(
      req("console/mode", `Bearer ${SESSION}`, { mode: "shadow", actor: "somebody-else" }),
    );
    const audit = db.inserted.find((i) => i.table === "operator_actions");
    expect(audit).toBeDefined();
    expect(audit!.row.actor).not.toBe("somebody-else");
    expect(audit!.row.actor_user_id).toBe("user-1");
    expect(audit!.row.auth_method).toBe("supabase");
  });

  it("records the shared token as such, so its retirement is observable", async () => {
    // `auth_method` is what turns "has anyone used the token lately?"
    // into a query rather than a guess.
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    env.CONTROL_API_TOKEN = TOKEN;
    const mod = await load("kill-switch");
    await mod.POST!(req("kill-switch", `Bearer ${TOKEN}`, { active: true }));
    const audit = db.inserted.find((i) => i.table === "operator_actions");
    expect(audit!.row.auth_method).toBe("shared_token");
    expect(audit!.row.actor_user_id).toBeNull();
  });

  it("the kill switch writes an audit row at all", async () => {
    // It did not before PR 12, despite the README claiming control
    // routes did — the largest hole in the trail, on its most
    // consequential action.
    db.account = { role: "operator", active: true };
    const mod = await load("kill-switch");
    await mod.POST!(req("kill-switch", `Bearer ${SESSION}`, { active: true }));
    const audit = db.inserted.find((i) => i.table === "operator_actions");
    expect(audit?.row.action).toBe("kill_switch");
  });
});
