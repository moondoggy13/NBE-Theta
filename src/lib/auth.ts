/**
 * Operator authentication for control-plane and alpha-internal routes.
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
 * **Reads are gated too.** The earlier routes gated POST only, on the
 * reasoning that reads are harmless. For `risk_state` that holds. For
 * `wallet_watchlist`, `venue_trades` and `wallet_positions` it does not:
 * those rows *are* the product. Which wallets we follow and what they
 * hold is the whole thesis, and it is worth more to a reader than the
 * ability to toggle a switch.
 *
 * **Fail-closed in production.** With `NODE_ENV=production` and no
 * usable token, every gated request is refused with 503 rather than
 * allowed. A misconfigured deployment must not silently serve an
 * unauthenticated control surface — that is precisely the failure this
 * module was written to fix.
 *
 * This is a shared bearer secret, not real identity. It is a deliberate
 * placeholder matching the existing `CONTROL_API_TOKEN` model, and it is
 * not sufficient for a public deployment: ADR-0002's rollout requires
 * SSO (Supabase Auth or Cloudflare Access) with per-operator roles
 * before live mode. What it *is* sufficient for is closing the gap
 * between "anyone on the internet" and "someone holding our secret".
 */
import { NextResponse } from "next/server";

const MIN_TOKEN_LENGTH = 16;

export type AuthResult = { ok: true } | { ok: false; response: NextResponse };

/**
 * Gate a request on the operator bearer token.
 *
 * Pass `{ allowDevBypass: false }` for anything that must be gated even
 * locally. The default bypass exists so a developer running
 * `pnpm dev` gets a working console without ceremony.
 */
export function requireOperator(
  req: Request,
  opts: { allowDevBypass?: boolean } = {},
): AuthResult {
  const allowDevBypass = opts.allowDevBypass ?? true;
  const isProd = process.env.NODE_ENV === "production";
  const expected = process.env.CONTROL_API_TOKEN;

  if (!isProd && allowDevBypass) return { ok: true };

  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, reason: "control api token not configured" },
        { status: 503 },
      ),
    };
  }

  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!constantTimeEquals(provided, expected)) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true };
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
