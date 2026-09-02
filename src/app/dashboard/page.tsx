import { OperatorConsole } from "@/components/console/OperatorConsole";

/**
 * Internal operator console.
 *
 * This page used to `redirect("/")` with the note "intentionally
 * unreachable until founder authentication and access policies are
 * implemented". That locked the door and left the windows open: the API
 * routes behind it were serving `wallet_watchlist`, `wallet_positions`
 * and `venue_trades` to unauthenticated callers the whole time (PR 9
 * closed that — see `src/lib/auth.ts`).
 *
 * With the routes gated, the page itself is safe to serve: the console
 * holds nothing until an operator supplies the token, and every fetch it
 * makes is refused without one. The token is a shared secret, not
 * identity — real SSO with per-operator roles is still required before
 * live mode.
 */
export default function DashboardPage() {
  return <OperatorConsole />;
}
