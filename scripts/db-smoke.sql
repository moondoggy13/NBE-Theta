-- Schema smoke test for the PR 2 migrations.
--
-- Run against a DB that has had `pnpm migrate up` applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-smoke.sql
--
-- Asserts (RAISEs EXCEPTION → non-zero exit on failure):
--   1. every new table exists,
--   2. RLS is enabled on every new table,
--   3. the deny-list tables have NO anon SELECT policy; the anon-list
--      tables DO,
--   4. the realtime publication contains the intended set and none of the
--      raw wallet/trade tables,
--   5. behaviorally: an anon-role SELECT sees an anon-allowed table's row
--      but is denied a deny-list table's row.
--
-- Everything runs inside a transaction that ROLLBACKs, so no test data
-- persists.

begin;

-- 1 + 2: existence + RLS enabled.
do $$
declare
  t text;
  all_new text[] := array[
    -- 005
    'events', 'markets', 'outcomes', 'market_rule_versions',
    -- 006
    'ingest_runs', 'ingest_cursors', 'raw_objects',
    -- 007
    'wallets', 'wallet_candidates', 'wallet_relationships', 'venue_trades',
    -- 008
    'wallet_ledger_entries', 'wallet_episodes',
    -- 009
    'wallet_score_snapshots', 'wallet_behavior_snapshots',
    'wallet_anomaly_events', 'wallet_tier_snapshots', 'signals',
    -- 010
    'execution_intents', 'venue_orders', 'venue_order_events', 'venue_fills',
    'venue_positions', 'account_snapshots', 'risk_snapshots',
    'operator_actions', 'process_heartbeats', 'reconciliation_runs',
    'reconciliation_breaks'
  ];
  rls boolean;
begin
  foreach t in array all_new loop
    if to_regclass('public.' || t) is null then
      raise exception 'missing table: %', t;
    end if;
    select relrowsecurity into rls from pg_class where oid = ('public.' || t)::regclass;
    if not rls then
      raise exception 'RLS not enabled on %', t;
    end if;
  end loop;
  raise notice 'ok: 29 tables exist with RLS enabled';
end $$;

-- 3: anon policy presence matches intent.
do $$
declare
  t text;
  anon_list text[] := array[
    'events', 'markets', 'outcomes', 'market_rule_versions',
    'ingest_runs', 'raw_objects',
    'signals', 'wallet_tier_snapshots', 'wallet_anomaly_events',
    'venue_orders', 'venue_fills', 'venue_positions', 'account_snapshots',
    'risk_snapshots', 'reconciliation_runs', 'reconciliation_breaks',
    'process_heartbeats', 'operator_actions'
  ];
  deny_list text[] := array[
    'ingest_cursors', 'wallets', 'wallet_candidates', 'wallet_relationships',
    'venue_trades', 'wallet_ledger_entries', 'wallet_episodes',
    'wallet_score_snapshots', 'wallet_behavior_snapshots',
    'execution_intents', 'venue_order_events'
  ];
  n int;
begin
  foreach t in array anon_list loop
    select count(*) into n from pg_policies
      where schemaname = 'public' and tablename = t and 'anon' = any(roles);
    if n = 0 then
      raise exception 'expected anon SELECT policy on % but found none', t;
    end if;
  end loop;
  foreach t in array deny_list loop
    select count(*) into n from pg_policies
      where schemaname = 'public' and tablename = t and 'anon' = any(roles);
    if n > 0 then
      raise exception 'unexpected anon policy on deny-list table %', t;
    end if;
    -- Privilege-level denial for EVERY deny table, not just the one the
    -- behavioral probe reads. Catches the supabase/postgres default-
    -- privileges auto-grant (tables created by supabase_admin are
    -- auto-granted to anon/authenticated unless explicitly revoked).
    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'anon has SELECT privilege on deny-list table %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception 'authenticated has SELECT privilege on deny-list table %', t;
    end if;
  end loop;
  raise notice 'ok: anon policies + privileges match intent';
end $$;

-- 4: realtime publication membership.
do $$
declare
  t text;
  must_have text[] := array[
    'markets', 'signals', 'wallet_tier_snapshots', 'wallet_anomaly_events',
    'venue_orders', 'venue_fills', 'venue_positions',
    'reconciliation_breaks', 'process_heartbeats'
  ];
  must_not text[] := array[
    'wallets', 'venue_trades', 'wallet_ledger_entries',
    'wallet_score_snapshots', 'execution_intents'
  ];
  n int;
begin
  foreach t in array must_have loop
    select count(*) into n from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t;
    if n = 0 then
      raise exception 'table % missing from supabase_realtime publication', t;
    end if;
  end loop;
  foreach t in array must_not loop
    select count(*) into n from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t;
    if n > 0 then
      raise exception 'raw table % must NOT be in supabase_realtime publication', t;
    end if;
  end loop;
  raise notice 'ok: realtime publication membership correct';
end $$;

-- 5: behavioral anon visibility. Insert one anon-allowed row (markets)
-- and one deny row (wallets) as the superuser, then read as the anon
-- role. anon should SELECT markets (granted + RLS allow-all policy) and
-- be DENIED wallets — note deny is at the privilege level (no GRANT), so
-- the read raises insufficient_privilege (42501), which is strictly
-- stronger than an RLS-filtered empty result.
insert into markets (
  venue, venue_market_id, venue_event_id, condition_id, question,
  active, closed, resolved, opened_at
) values (
  'polymarket', 'smoke-mkt', 'smoke-evt', '0xsmoke', 'smoke?',
  true, false, false, now()
);
insert into wallets (chain_id, address) values (137, '0xsmoke');

do $$
declare
  anon_markets int;
  denied boolean := false;
begin
  set local role anon;
  select count(*) into anon_markets from markets where venue_market_id = 'smoke-mkt';
  begin
    perform 1 from wallets where address = '0xsmoke';
  exception when insufficient_privilege then
    denied := true;
  end;
  reset role;
  if anon_markets <> 1 then
    raise exception 'anon should see markets row, saw %', anon_markets;
  end if;
  if not denied then
    raise exception 'anon must be denied SELECT on wallets, but the read succeeded';
  end if;
  raise notice 'ok: anon sees markets (%), denied on wallets (privilege)', anon_markets;
end $$;

rollback;
