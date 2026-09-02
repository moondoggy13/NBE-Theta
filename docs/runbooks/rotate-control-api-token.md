# Runbook — rotate `CONTROL_API_TOKEN`

**When:** on any suspicion of exposure, when an operator leaves, and once
now as a matter of course — the four routes listed below served RLS
deny-list tables *unauthenticated* until PR 9 (`bfb05a9`), so anything
they exposed should be treated as having been public for that window.

**Time:** about five minutes. **Reversible:** yes — set the old value
back and redeploy.

## What the token actually protects

Not just the kill switch. `requireOperator` in `src/lib/auth.ts` gates
every route that reads an RLS deny-list table with the Supabase
*service-role* key, which bypasses RLS entirely:

| Route | Reads |
|---|---|
| `/api/console/{signals,cohort,portfolio,health,mode,gate}` | signal evaluations, cohort, strategy lots, shadow fills, gate packets |
| `/api/smart-money/{leaders,flows,tape}` | `wallets`, `wallet_positions`, `venue_trades`, `leaderboard_snapshots` |
| `/api/watchlist` (GET **and** POST) | `wallet_watchlist` |
| `/api/kill-switch` (POST) | `risk_state` |

The RLS deny-list and this token are two halves of one control: the
migrations stop the *browser* reading those tables, the token stops a
*route* handing over the same rows. Rotating it is the only way to
revoke access short of taking the deployment down.

## Procedure

1. **Generate a new token.** Do this on your own machine — never paste a
   live secret into an agent session, a ticket, or a chat log, all of
   which are retained.

   ```bash
   openssl rand -hex 32
   ```

   Minimum 16 characters (`MIN_TOKEN_LENGTH` in `src/lib/auth.ts`); 32
   bytes of hex is 64 characters and is the recommended size.

2. **Set it in the hosting environment**, for every environment that
   serves the console — production *and* preview. Preview deployments
   run with `NODE_ENV=production`, so a preview without the variable
   fails closed (503) rather than opening up; that is safe, but it also
   means a preview with the *old* value keeps honouring it.

3. **Redeploy.** The value is read from `process.env` at request time,
   but a running deployment holds the environment it started with. **The
   old token keeps working until the redeploy completes** — this is the
   step people skip, and skipping it means the rotation has not
   happened.

4. **Verify the new token works, and the old one does not.** Against the
   deployed URL, not localhost — the dev bypass in `requireOperator`
   makes a local check meaningless:

   ```bash
   # expect 200
   curl -si -H "authorization: Bearer $NEW" https://<host>/api/console/health | head -1
   # expect 401
   curl -si -H "authorization: Bearer $OLD" https://<host>/api/console/health | head -1
   # expect 401
   curl -si https://<host>/api/console/health | head -1
   ```

   A 503 on all three means the variable did not reach the deployment.
   That is fail-closed working correctly, not a rotation — go back to
   step 2.

5. **Update local `.env.local`** for anyone running `pnpm dev` against a
   production-like config, and any CI or script that holds the value.
   CI does **not** need it: no workflow sets `CONTROL_API_TOKEN`, and
   the tests inject their own.

## Afterwards

Operators holding the old token are logged out. The console keeps it in
`sessionStorage` (not `localStorage`), so it is already gone from any
closed tab; anyone with a tab open re-enters the new one at the prompt.
Nothing else caches it.

## Known limitation

This is a shared secret, not identity. Everyone holds the same string,
so rotation is all-or-nothing and the audit rows in `operator_actions`
record a self-declared `actor` rather than an authenticated one. ADR-0002
requires real SSO with per-operator roles before live mode; until then,
rotation is the only revocation mechanism there is.
