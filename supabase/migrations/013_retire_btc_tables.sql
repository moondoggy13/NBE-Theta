-- ────────────────────────────────────────────────────────────────────────────
-- 013 — Retire the BTC-era tables (step 1 of 2: stop reading/writing)
--
-- The BTC/Coinbase system was deleted from the working tree; it survives
-- only behind the git tag `btc-v1-final`. Its tables, created by
-- migrations 002-004, are still in the database and still reachable:
-- migration 003 granted `anon` read on all of them ("v1 is a
-- single-tenant trading bot, so anon gets read-everything; lock down
-- later if multi-tenant ever applies") and published seven of them to
-- `supabase_realtime`. Nothing writes to them any more, so they are
-- empty on a live deployment — but the browser-reachable surface is
-- real, and every one of them is dead weight in the Realtime stream.
--
-- This migration is the AGENTS.md two-step deprecation, step 1: stop
-- using the tables, keep the data. It does NOT drop anything. A
-- follow-up migration may drop them after >= 30 days, and its commit
-- message must say "APPROVED: destructive migration".
--
-- `risk_state` is deliberately NOT retired. It is the only pre-pivot
-- table the current system still uses (`/api/kill-switch`,
-- `/api/health`) and it is venue-neutral — a kill switch is a kill
-- switch. The executor (PR 8) will keep using it.
--
-- Idempotent: re-running is a no-op.
--
-- -- Down: re-add the tables to supabase_realtime and re-create the
-- --       "anon read <table>" select policies from migrations 003/004
-- --       (grant select on <table> to anon, authenticated).
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  -- Every table created by migrations 002-004 that the Polymarket
  -- system does not use. `risk_state` is excluded on purpose.
  retired_tables text[] := array[
    -- 002
    'claude_analyses',
    -- 003
    'candles', 'ticks', 'l2_snapshots', 'strategy_signals',
    'orders', 'fills', 'positions', 'pnl_snapshots',
    'backtest_runs', 'system_logs',
    -- 004
    'regime_posteriors', 'master_weights', 'strategy_validation'
  ];
begin
  foreach t in array retired_tables loop
    -- Tolerate a database where an individual table was never created
    -- (e.g. a deployment that skipped a migration); this is cleanup,
    -- not a schema requirement.
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;

    -- 1. Deny browser reads. RLS stays enabled and the anon policy goes
    --    away. The explicit revoke matters as much as the policy drop:
    --    supabase/postgres sets ALTER DEFAULT PRIVILEGES so tables
    --    created by supabase_admin are auto-granted to anon and
    --    authenticated, and a table with a grant but no policy is
    --    still a table anon can name in a query.
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon read %1$s" on %1$I', t);
    execute format('revoke all on %I from anon, authenticated', t);

    -- 2. Stop streaming. Removing a table from a publication drops no
    --    rows; it only stops change events for it.
    begin
      execute format('alter publication supabase_realtime drop table %I', t);
    exception
      -- Not in the publication (fresh DB, or already run). Fine.
      when undefined_object then null;
      when others then null;
    end;

    -- 3. Mark it, so anyone reading the schema sees the status without
    --    having to find this file.
    execute format(
      'comment on table %I is %L',
      t,
      'RETIRED (migration 013): pre-pivot BTC system, deleted from the '
      || 'working tree at tag btc-v1-final. Nothing reads or writes this '
      || 'table. Droppable in a follow-up migration; see AGENTS.md.'
    );
  end loop;
end $$;

-- `risk_state` survives the pivot, but its comment should say why.
do $$
begin
  if to_regclass('public.risk_state') is not null then
    -- COMMENT ON takes a literal, not an expression, so it has to go
    -- through EXECUTE to be built from concatenated parts.
    execute format(
      'comment on table risk_state is %L',
      'LIVE. Venue-neutral kill-switch / risk state. Predates the '
      || 'Polymarket pivot and is retained deliberately: read by '
      || '/api/health and read+written by /api/kill-switch, and the '
      || 'executor (PR 8) will use it too.'
    );
  end if;
end $$;
