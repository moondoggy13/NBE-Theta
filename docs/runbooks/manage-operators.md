# Runbook — add, change, or remove an operator

Operator access is two things, and both are required:

1. **An identity** — a Supabase Auth user in this project.
2. **A grant** — a row in `operator_accounts` giving that user a role.

Signing in is not access. A valid Supabase session with no
`operator_accounts` row is refused with 403, which is deliberate: without
it, the project's signup page would be the access control. See
`docs/adr/0004-operator-identity.md`.

## Roles

| Role | May |
|---|---|
| `viewer` | read the console — cohort, signals, portfolio, gate, health |
| `operator` | change state — watchlist, kill switch, mode to paused/shadow |
| `admin` | everything, including promotion to **live** |

Higher satisfies lower: an `admin` passes any check an `operator` would.

Grant the **lowest** role that lets someone do their job. In particular,
`operator` is enough to hit the kill switch — nobody needs `admin` to
stop trading, only to start it.

## Add an operator

1. **Create the Supabase user.** Supabase dashboard → Authentication →
   Users → Add user (or invite by email). Copy the user's UUID.

2. **Grant a role.** Against the project database, as service-role:

   ```sql
   insert into operator_accounts (user_id, email, role, created_by, note)
   values (
     '00000000-0000-0000-0000-000000000000',  -- the UUID from step 1
     'person@example.com',
     'viewer',                                 -- lowest that suffices
     'your-name',
     'why this person has access'
   );
   ```

3. **Have them sign in** at `/dashboard` and confirm the header shows
   their email and role. If they get 403 after a successful sign-in, the
   row is missing or the UUID does not match.

## Change a role

```sql
update operator_accounts
   set role = 'operator', updated_at = now()
 where user_id = '…';
```

Takes effect on their next request — the role is read per request, not
cached in the session.

## Remove an operator

**Deactivate; do not delete.**

```sql
update operator_accounts
   set active = false, updated_at = now()
 where user_id = '…';
```

Deleting the row orphans the `operator_actions` rows that reference it,
which defeats the audit trail the table exists to support. An inactive
account is refused with 403 on the next request.

Also disable or delete the Supabase Auth user if they should not be able
to authenticate at all — deactivating the grant is sufficient for this
application, but the identity remains valid elsewhere in the project.

## Check who has access

```sql
select email, role, active, created_by, created_at
  from operator_accounts
 order by role desc, email;
```

## Check whether the shared token is still in use

This is the query that decides when `CONTROL_API_TOKEN` can be removed
(ADR-0004, follow-up):

```sql
select count(*), max(occurred_at)
  from operator_actions
 where auth_method = 'shared_token'
   and occurred_at > now() - interval '30 days';
```

Zero over a meaningful window means every operator has moved to a real
account and the token path can be deleted in a follow-up PR — itself a
risk-gate change needing an ADR, a test, and review.

Note that this counts **write** actions only. A shared-token holder doing
nothing but reading leaves no `operator_actions` row, so a zero here is
evidence about writers, not proof that nobody holds the token. Rotate it
(`docs/runbooks/rotate-control-api-token.md`) rather than assuming it is
unused.
