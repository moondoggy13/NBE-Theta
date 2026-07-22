-- ────────────────────────────────────────────────────────────────────────────
-- PR 2 / 005 — Polymarket market registry
--
-- Additive. Mirrors packages/contracts (Event, Market, Outcome,
-- MarketRuleVersion) field-for-field. condition/token ids are TEXT
-- (they overflow numeric and vary by driver). Nothing writes here until
-- PR 3 (the Gamma registry poller).
--
-- Security note: unlike the BTC schema (migration 003, "anon gets
-- read-everything"), the pivot restricts anon. Registry data is public
-- Polymarket info, so these four tables ARE anon-readable; the raw
-- wallet/trade/intel tables added in later migrations are NOT.
--
-- -- Down: drop table market_rule_versions, outcomes, markets, events cascade;
-- --       (and remove them from supabase_realtime).
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- A real-world event that groups related markets.
create table if not exists events (
  venue          text        not null,
  venue_event_id text        not null,
  title          text        not null,
  category       text,
  opened_at      timestamptz not null,
  closes_at      timestamptz,
  status         text        not null check (status in ('active', 'closed', 'resolved')),
  raw_object_id  uuid,
  primary key (venue, venue_event_id)
);
create index if not exists events_status_idx on events (status, opened_at desc);

-- A single market on a venue.
create table if not exists markets (
  venue                   text        not null,
  venue_market_id         text        not null,
  venue_event_id          text        not null,
  condition_id            text        not null,
  question                text        not null,
  neg_risk                boolean     not null default false,
  active                  boolean     not null,
  closed                  boolean     not null,
  resolved                boolean     not null,
  opened_at               timestamptz not null,
  closes_at               timestamptz,
  resolved_at             timestamptz,
  resolution_source       text,
  current_rule_version_id uuid,
  primary key (venue, venue_market_id)
);
create index if not exists markets_condition_idx on markets (condition_id);
create index if not exists markets_active_idx on markets (active, closes_at);
create index if not exists markets_event_idx on markets (venue, venue_event_id);

-- Tradable outcome tokens (one row per YES/NO leg).
create table if not exists outcomes (
  venue            text    not null,
  venue_market_id  text    not null,
  outcome_index    integer not null check (outcome_index >= 0),
  outcome_name     text    not null,
  outcome_token_id text    not null,
  primary key (venue, venue_market_id, outcome_index)
);
create index if not exists outcomes_token_idx on outcomes (outcome_token_id);

-- Snapshot of a market's resolution rules. A mid-market rule change
-- becomes a NEW row (unique on rule_hash), never an in-place edit.
create table if not exists market_rule_versions (
  id                uuid        primary key default gen_random_uuid(),
  venue             text        not null,
  venue_market_id   text        not null,
  observed_at       timestamptz not null,
  rule_hash         text        not null,
  title             text        not null,
  description       text,
  resolution_source text,
  close_time        timestamptz,
  raw_object_id     uuid,
  unique (venue, venue_market_id, rule_hash)
);
create index if not exists market_rule_versions_market_idx
  on market_rule_versions (venue, venue_market_id, observed_at desc);

-- Realtime: the Markets tab streams live market status.
do $$
begin
  begin
    alter publication supabase_realtime add table markets;
  exception when others then null; end;
end $$;

-- RLS. Registry is public info → anon-read. service_role bypasses RLS.
do $$
declare
  t text;
  anon_tables text[] := array['events', 'markets', 'outcomes', 'market_rule_versions'];
begin
  foreach t in array anon_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('grant select on %I to anon', t);
    execute format(
      'drop policy if exists "anon read %1$s" on %1$I; '
      || 'create policy "anon read %1$s" on %1$I for select to anon using (true);',
      t
    );
  end loop;
end $$;
