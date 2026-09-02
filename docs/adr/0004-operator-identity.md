# ADR-0004: Per-operator identity and roles

- **Status**: Accepted
- **Date**: 2026-09-02
- **Deciders**: repository owner
- **Extends**: ADR-0002 (which names SSO as required before live mode)
- **Risk gate**: yes. Regression test
  `src/app/api/__tests__/risk-gate-operator-roles.test.ts`. Per AGENTS.md
  this also requires **review by someone other than its author**.

## Context

Every operator shared one bearer string. `src/lib/auth.ts` has described
that as a deliberate placeholder since PR 9, and ADR-0002's rollout names
SSO with per-operator roles as a prerequisite for live mode. It was the
last such prerequisite still outstanding.

Three failure modes, in increasing order of severity:

1. **Revocation is all-or-nothing.** One person leaves and everybody's
   credential changes. In practice that means it does not happen.
2. **No least privilege.** Whoever can read the cohort can also arm live
   trading. There is no way to give someone the ability to hit the kill
   switch without also giving them the ability to start trading.
3. **The audit trail was self-declared.** `/api/console/mode` read
   `actor` from the request *body*. A caller holding the token could
   record a mode change under any name they chose. An audit log written
   by the audited party is not an audit log, and `operator_actions` was
   the only record of who armed live trading.

The third is the one that turns a weak control into a misleading one.

## Decision

**1. A verified Supabase session establishes identity;
`operator_accounts` grants authority.**

`requireOperator` returns a `Principal` — user id, email, role, and the
mechanism that proved it. The id comes from Supabase's auth server, the
role from `operator_accounts` (migration 019).

Keeping those separate is the point: **a valid login is not
authorisation**. Anyone who can sign up to the Supabase project can
obtain a session; only someone with an `operator_accounts` row can act.
Collapsing the two would make the project's signup page the access
control.

**2. Three roles, because there are three distinct questions.**

| Role | May |
|---|---|
| `viewer` | read the console — cohort, signals, portfolio, gate, health |
| `operator` | change state — watchlist, kill switch, mode to paused/shadow |
| `admin` | everything, including promotion to **live** |

Two would not have been enough. The read/write split and the "may arm
real money" split are different: someone who should see the cohort need
not be able to stop trading, and someone who should be able to *stop*
trading — the kill switch — must not have to be trusted to *start* it.
Making the emergency stop require the highest privilege would be exactly
backwards.

**3. Verification asks the auth server, not the signature.**

`getUser(jwt)` costs a round trip per request. For an operator console
that is irrelevant, and it buys what local signature verification cannot:
a token belonging to a deleted or signed-out user stops working
immediately rather than at expiry.

**4. The shared token survives, capped, and its retirement is
observable.**

Removing it in the same step would risk either locking every operator out
or — worse — a misconfiguration that opens up. So this follows the
two-step rule AGENTS.md already applies to dropping a column: run both,
prove the new path, then remove the old one.

Two things make that safe rather than merely convenient:

- **The token is capped at `operator`** (`CONTROL_API_TOKEN_ROLE`,
  default `operator`). It therefore *cannot arm live trading*. Promotion
  to live requires a named human with an account, which is what ADR-0002
  was asking for. An explicit `CONTROL_API_TOKEN_ROLE=admin` overrides
  that, which someone has to write into an env file deliberately rather
  than get by default.
- **`operator_actions.auth_method`** records `supabase` or
  `shared_token` on every action. "Has anyone used the token lately?"
  becomes a query rather than a guess, and the answer is what authorises
  step two.

**5. The audit actor comes from the principal, never the request.**

`body.actor` is gone. `auditFields(principal)` supplies `actor`,
`actor_user_id`, `actor_email` and `auth_method` together so no route can
record an action without saying who did it and how they proved it. The
kill switch, which wrote **no** audit row at all before this PR despite
the README claiming otherwise, now writes one.

**6. Fail closed on every branch.** No credential, unverifiable session,
missing account row, inactive account, insufficient role, or a database
that cannot answer — all refuse. A 503 is reserved for "a mechanism
exists and could not be reached"; a credential that is simply wrong gets
401, so real outages are not buried under bad-password noise.

## Consequences

- **Positive**: revocation is now per-person (deactivate a row).
  Least privilege exists. The audit trail names a verified human.
- **Positive**: promotion to live requires an account, which enforces
  ADR-0002's SSO precondition rather than restating it.
- **Negative**: an operator account must be created out of band before
  anyone can use the console — there is no self-service and no
  invitation flow. That is deliberate for a system of this size, and
  `docs/runbooks/manage-operators.md` documents it, but it does mean
  onboarding is a manual step.
- **Negative**: Supabase's auth server is now in the request path for
  every gated call. If it is unreachable the console is unusable — the
  correct failure, but a new dependency.
- **Known limitation**: sessions are validated but the console holds the
  access token in `sessionStorage` and does not refresh it, so a long
  session ends in a re-login rather than a silent refresh. Acceptable
  for an internal tool; worth revisiting if the console gains
  long-running views.

## Follow-up, deliberately not in this PR

**Remove `CONTROL_API_TOKEN`.** Once `select count(*) from
operator_actions where auth_method = 'shared_token' and occurred_at >
now() - interval '30 days'` returns zero, the token path can be deleted.
That is a second risk-gate change and needs its own ADR, test, and
review.

## Related documents

- `docs/adr/0002-overlord-copy-trading.md` — names SSO as a live-mode
  prerequisite
- `docs/adr/0003-shadow-gate-enforcement.md` — the other machine-checked
  live-mode precondition
- `docs/runbooks/manage-operators.md` — adding and removing operators
- `docs/runbooks/rotate-control-api-token.md` — rotating the shared token
  while it still exists
