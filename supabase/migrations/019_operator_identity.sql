-- ────────────────────────────────────────────────────────────────────────────
-- PR 12 / 019 — Operator identity and roles
--
-- Additive. Replaces "everyone shares one bearer string" with per-operator
-- identity, which ADR-0002 requires before live mode and which
-- `src/lib/auth.ts` has described as a deliberate placeholder since PR 9.
--
-- Two things change, and the second matters more than it looks:
--
--   operator_accounts   — who may act, and in what capacity.
--   operator_actions    — gains the VERIFIED identity behind an action.
--
-- The audit columns are the point. `operator_actions.actor` is a free-text
-- field that routes fill from the request body (see /api/console/mode
-- before this PR), so a caller holding the shared token could record a
-- mode change as anyone. An audit log that the audited party writes is
-- not an audit log. `actor_user_id` is set from a server-verified
-- Supabase session and cannot be chosen by the caller.
--
-- `auth_method` exists so the shared token's retirement is observable
-- rather than guessed at. While both mechanisms are accepted, this column
-- says which one each action used; when no row has said 'shared_token'
-- for long enough, the token can be removed in a follow-up. That is the
-- same two-step discipline AGENTS.md requires for dropping a column —
-- stop using it, prove it, then remove it.
--
-- Security: operator_accounts is the authorization table itself. Anon
-- read would let anyone enumerate operators and see who holds admin.
-- RLS on, NO anon policy, explicit revoke.
--
-- -- Down: drop table operator_accounts cascade;
-- --       alter table operator_actions drop column actor_user_id,
-- --         drop column actor_email, drop column auth_method;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Operator accounts ─────────────────────────────────────────────────
-- `user_id` is the Supabase `auth.users` id. No foreign key: `auth` is
-- Supabase's own schema, our migrations run against plain Postgres in CI
-- and local dev where it does not exist, and a hard reference would make
-- the whole migration chain undeployable outside Supabase. The
-- application verifies the id against the auth server on every request,
-- which is a stronger check than referential integrity would be — it
-- also catches a user deleted after the row was written.
create table if not exists operator_accounts (
  user_id     uuid        primary key,
  email       text,
  -- viewer   — read the console. Alpha internals, not controls.
  -- operator — change state: watchlist, kill switch, paused/shadow mode.
  -- admin    — everything, including promotion to live.
  --
  -- Three levels rather than two because the read/write split and the
  -- "may arm real money" split are different questions. Someone who
  -- should see the cohort need not be able to stop trading, and someone
  -- who should be able to hit the kill switch need not be able to arm
  -- live trading.
  role        text        not null default 'viewer'
    check (role in ('viewer', 'operator', 'admin')),
  -- Deactivation rather than deletion: an inactive account keeps its id
  -- so historical operator_actions rows still resolve to a person.
  -- Deleting the row would orphan the audit trail it exists to support.
  active      boolean     not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now()
);
create index if not exists operator_accounts_role_idx
  on operator_accounts (role) where active;

-- ── Verified actor on the audit trail ─────────────────────────────────
-- `actor` (free text) stays for continuity with existing rows. The new
-- columns are the trustworthy ones, and they are nullable because rows
-- written before this migration genuinely do not have a verified
-- identity behind them — backfilling a value would be inventing one.
alter table operator_actions
  add column if not exists actor_user_id uuid;

alter table operator_actions
  add column if not exists actor_email text;

-- 'supabase' | 'shared_token'. Nullable for the same reason: rows
-- predating this column were all shared-token, but recording that now
-- would be an assertion nothing verified at the time.
alter table operator_actions
  add column if not exists auth_method text;

create index if not exists operator_actions_actor_idx
  on operator_actions (actor_user_id, occurred_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────
do $$
begin
  execute 'alter table operator_accounts enable row level security';
  execute 'drop policy if exists "anon read operator_accounts" on operator_accounts';
  -- Explicit revoke: supabase/postgres auto-grants new tables to
  -- anon/authenticated via ALTER DEFAULT PRIVILEGES. Without this the
  -- table that decides who is an admin would be world-readable.
  execute 'revoke all on operator_accounts from anon, authenticated';
end $$;

-- ── Retire the anon read on operator_actions ──────────────────────────
-- Migration 010 gave the audit log an anon SELECT policy and put it in
-- the realtime publication. Nothing ever used either: the only reader is
-- /api/console/health, which is operator-gated and goes through the
-- service-role key.
--
-- Leaving it open was already questionable — an audit log says who did
-- what and when, which is operational intelligence — and this migration
-- makes it untenable by adding `actor_email`. A browser-reachable table
-- listing operator email addresses against the actions they took is a
-- privacy leak with no compensating use.
--
-- This is a revocation, not a grant, so it fails in the safe direction:
-- the worst case is a reader that has to authenticate.
do $$
begin
  execute 'drop policy if exists "anon read operator_actions" on operator_actions';
  execute 'revoke all on operator_actions from anon, authenticated';
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'operator_actions'
  ) then
    -- Streaming a table anon can no longer read is dead weight at best.
    execute 'alter publication supabase_realtime drop table operator_actions';
  end if;
end $$;
