/**
 * Operator authentication and authorization.
 *
 * **Why this module exists.** Server routes use `serverClient()`, which
 * holds the Supabase service-role key and therefore *bypasses RLS
 * entirely*. That is correct — the worker and the console both need to
 * read tables the browser must never reach. But it means the RLS
 * deny-list in the migrations protects nothing on its own: a route that
 * queries `wallet_positions` with the service-role key and returns the
 * result to an unauthenticated caller has walked straight around it.
 *
 * So the deny-list and this check are two halves of one control. The
 * migrations stop the *browser* reading those tables directly; this
 * stops a *route* handing the same rows to anyone who asks. Either half
 * alone is not a boundary.
 *
 * **PR 12: identity, not just a password.** Until now every operator
 * shared one bearer string. That has three failure modes this module now
 * closes, and they get worse in order:
 *
 *   1. Revocation is all-or-nothing. One person leaves, everybody's
 *      credential changes.
 *   2. There is no least privilege. Whoever can read the cohort can also
 *      arm live trading.
 *   3. **The audit trail is self-declared.** `/api/console/mode` read
 *      `actor` from the request *body*, so a caller could record a mode
 *      change as anyone. A log the audited party writes is not a log.
 *
 * A verified Supabase session fixes all three: `requireOperator` returns
 * a `Principal` whose `userId` came from the auth server, routes record
 * *that* rather than anything the caller sent, and `operator_accounts`
 * carries a role.
 *
 * **The shared token still works, deliberately.** It is the only thing
 * standing between the internet and the deny-list tables today, and
 * swapping one boundary for another in a single step risks either
 * locking every operator out or — much worse — a misconfiguration that
 * opens up. So this follows the same two-step rule AGENTS.md applies to
 * dropping a column: run both, prove the new path, then remove the old
 * one. `auth_method` on `operator_actions` is what makes "prove" a query
 * rather than a feeling: when nothing has authenticated with
 * `shared_token` for long enough, `CONTROL_API_TOKEN` can go.
 *
 * **Fail-closed, on every branch.** No token, unverifiable token, no
 * account row, inactive account, insufficient role, or a database that
 * cannot answer — all refuse. The one thing this module must never do is
 * treat "I could not tell" as "yes"; an outage would then be the
 * cheapest way past it.
 */
import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/client";

const MIN_TOKEN_LENGTH = 16;

export type Role = "viewer" | "operator" | "admin";

/** Ascending capability. A higher rank satisfies a lower requirement. */
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export const ROLES: Role[] = ["viewer", "operator", "admin"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

/**
 * Who is making this request, as established by the server.
 *
 * Nothing here is caller-supplied. `userId` and `email` come from
 * Supabase's auth server; `role` comes from `operator_accounts`. Routes
 * write these to `operator_actions` instead of anything in the body.
 */
export interface Principal {
  userId: string | null;
  email: string | null;
  role: Role;
  method: "supabase" | "shared_token";
  /** What to put in the free-text `operator_actions.actor` column. */
  label: string;
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse };

interface Options {
  /** Minimum role required. Defaults to the least privileged. */
  role?: Role;
  /**
   * Allow the unauthenticated local-dev bypass. Defaults to true so
   * `pnpm dev` gives a working console without ceremony. Pass false for
   * anything that must be gated even locally.
   */
  allowDevBypass?: boolean;
}

function deny(reason: string, status: number): AuthResult {
  return { ok: false, response: NextResponse.json({ ok: false, reason }, { status }) };
}

/**
 * The role granted to a caller presenting the shared token.
 *
 * Defaults to `operator`, not `admin`: the token is a transitional
 * credential held by more people than it should be, and it must not be
 * able to arm live trading. Promotion to live requires a named human.
 * An explicit `CONTROL_API_TOKEN_ROLE=admin` can override that, which is
 * a deliberate choice someone has to write down in an env file rather
 * than something they get by default.
 */
function sharedTokenRole(): Role {
  const configured = process.env.CONTROL_API_TOKEN_ROLE;
  return isRole(configured) ? configured : "operator";
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Gate a request, returning the verified principal behind it.
 *
 * Order matters. The shared token is checked *first* and by
 * constant-time comparison against a known string, so a token-holder
 * never reaches the auth server; anything else is offered to Supabase as
 * a session JWT. Doing it the other way round would send the shared
 * secret to an external service on every request.
 */
export async function requireOperator(req: Request, opts: Options = {}): Promise<AuthResult> {
  const required = opts.role ?? "viewer";
  const allowDevBypass = opts.allowDevBypass ?? true;
  const isProd = process.env.NODE_ENV === "production";
  const presented = bearer(req);

  if (!isProd && allowDevBypass && !presented) {
    return {
      ok: true,
      principal: {
        userId: null,
        email: null,
        role: "admin",
        method: "shared_token",
        label: "dev-bypass",
      },
    };
  }

  const expected = process.env.CONTROL_API_TOKEN;
  const tokenConfigured = Boolean(expected) && (expected as string).length >= MIN_TOKEN_LENGTH;

  if (tokenConfigured && constantTimeEquals(presented, expected as string)) {
    const role = sharedTokenRole();
    if (RANK[role] < RANK[required]) {
      // The token-holder is authenticated but not authorised. 403, not
      // 401: retrying with the same credential will never work, and
      // saying so is not a disclosure — they already hold the token.
      return deny(`shared token is limited to '${role}'; '${required}' required`, 403);
    }
    return {
      ok: true,
      principal: {
        userId: null,
        email: null,
        role,
        method: "shared_token",
        label: "shared-token",
      },
    };
  }

  // No Supabase means there is no second mechanism this credential
  // could possibly satisfy, so the answer is a definite "no" rather than
  // "I could not tell". The distinction is worth keeping precise: 503 is
  // for a mechanism that exists and could not be reached, and using it
  // for a credential that is simply wrong would hide real outages in a
  // sea of bad-password noise.
  if (!supabaseConfigured()) {
    if (!tokenConfigured) {
      // Nothing at all is configured to authenticate against. In
      // production that is a broken deployment, and it must refuse
      // rather than serve an ungated control surface.
      return deny("no authentication mechanism configured", 503);
    }
    return deny("unauthorized", 401);
  }

  if (!presented) return deny("unauthorized", 401);

  return verifySupabase(presented, required);
}

function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Verify a Supabase session JWT and resolve its role.
 *
 * The token is validated by asking the auth server (`getUser`) rather
 * than by checking its signature locally. That costs a round trip per
 * request, which for an operator console is irrelevant, and buys the
 * thing local verification cannot give: a token for a deleted or
 * signed-out user stops working immediately instead of at expiry.
 */
async function verifySupabase(token: string, required: Role): Promise<AuthResult> {
  const sb = serverClient();
  if (!sb) return deny("supabase not configured", 503);

  let userId: string;
  let email: string | null;
  try {
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) return deny("unauthorized", 401);
    userId = data.user.id;
    email = data.user.email ?? null;
  } catch {
    // A network failure reaching the auth server is "we could not tell",
    // and this module never converts that into "yes".
    return deny("could not verify session", 503);
  }

  const { data: rows, error } = await sb
    .from("operator_accounts")
    .select("user_id, email, role, active")
    .eq("user_id", userId)
    .limit(1);

  // Fail closed on a query error. Treating it as "no account" would
  // also refuse, but it would refuse with the wrong status and hide an
  // outage as a permissions problem.
  if (error) return deny("could not resolve operator account", 503);

  const account = ((rows ?? []) as unknown as {
    role?: string;
    active?: boolean;
    email?: string | null;
  }[])[0];

  // A valid Supabase login is not by itself authorisation. Anyone who
  // can sign up to the project would otherwise be an operator.
  if (!account) return deny("no operator account for this identity", 403);
  if (account.active === false) return deny("operator account is inactive", 403);
  if (!isRole(account.role)) return deny("operator account has no valid role", 403);
  if (RANK[account.role] < RANK[required]) {
    return deny(`role '${account.role}' is insufficient; '${required}' required`, 403);
  }

  return {
    ok: true,
    principal: {
      userId,
      email: email ?? account.email ?? null,
      role: account.role,
      method: "supabase",
      label: email ?? account.email ?? userId,
    },
  };
}

/**
 * The audit fields for a principal.
 *
 * Routes spread this into their `operator_actions` insert so the three
 * columns always travel together and no route can record an action
 * without saying who did it and how they proved it.
 */
export function auditFields(p: Principal): {
  actor: string;
  actor_user_id: string | null;
  actor_email: string | null;
  auth_method: string;
} {
  return {
    actor: p.label,
    actor_user_id: p.userId,
    actor_email: p.email,
    auth_method: p.method,
  };
}

/**
 * Length-independent comparison.
 *
 * The early return on differing lengths does leak length, which is
 * acceptable: the token length is a deployment constant, not a secret,
 * and comparing padded buffers to hide it would add complexity for no
 * real gain. What matters is that two same-length tokens take the same
 * time to reject regardless of where they first differ.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
