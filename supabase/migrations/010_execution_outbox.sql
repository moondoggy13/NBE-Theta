-- ────────────────────────────────────────────────────────────────────────────
-- PR 2 / 010 — Execution outbox + order lifecycle + ops
--
-- Additive. The durable execution-intent outbox (claimed with FOR UPDATE
-- SKIP LOCKED — NEVER LISTEN/NOTIFY as the delivery mechanism), the
-- append-only order-event log with a current-state read model, fills,
-- positions, account/risk snapshots, the immutable operator-action audit
-- log, heartbeats, and reconciliation records.
--
-- These live alongside the frozen BTC tables (orders/fills/positions from
-- migration 003) without collision — the new tables are venue_*-prefixed.
--
-- Security:
--   deny (outbox holds intent payloads; operational secret): execution_intents.
--   anon-read (operational read-models for the dashboard): venue_orders,
--     venue_fills, venue_positions, account_snapshots, risk_snapshots,
--     reconciliation_runs, reconciliation_breaks, process_heartbeats,
--     operator_actions.
-- Realtime: venue_orders, venue_fills, venue_positions,
--   reconciliation_breaks, process_heartbeats.
--
-- -- Down: drop table reconciliation_breaks, reconciliation_runs,
-- --       process_heartbeats, operator_actions, risk_snapshots,
-- --       account_snapshots, venue_positions, venue_fills,
-- --       venue_order_events, venue_orders, execution_intents cascade;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Durable outbox. dedupe_key is unique so a producer retry can't double-
-- insert. The executor claims with:
--   select ... where status='ready' and available_at<=now()
--     and expires_at>now() order by created_at
--     for update skip locked limit 1;
-- payload is the full OrderIntent (validated against contracts on claim).
create table if not exists execution_intents (
  id            uuid        primary key default gen_random_uuid(),
  strategy_type text        not null,
  dedupe_key    text        not null unique,
  payload       jsonb       not null,
  status        text        not null default 'ready'
    check (status in (
      'ready', 'claimed', 'risk_approved', 'risk_rejected', 'signed',
      'submitted', 'live', 'partially_filled', 'cancel_pending',
      'canceled', 'filled', 'rejected', 'expired',
      'settlement_pending', 'settled', 'reconciliation_break'
    )),
  available_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  attempt_count integer     not null default 0,
  claimed_at    timestamptz,
  claimed_by    text,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- The claim query's supporting index.
create index if not exists execution_intents_claim_idx
  on execution_intents (status, available_at, created_at)
  where status = 'ready';

-- Current-state read model of a venue order (projected from events).
create table if not exists venue_orders (
  venue_order_id   text          not null,
  client_intent_id uuid          not null,
  venue            text          not null,
  account_id       text          not null,
  condition_id     text          not null,
  outcome_token_id text          not null,
  side             text          not null check (side in ('BUY', 'SELL')),
  quantity         numeric(30,10) not null,
  limit_price      numeric(20,10) not null,
  time_in_force    text          not null check (time_in_force in ('GTC', 'GTD', 'FOK', 'FAK')),
  status           text          not null,
  filled_quantity  numeric(30,10) not null default 0,
  fees_paid        numeric(30,10) not null default 0,
  created_at       timestamptz   not null,
  updated_at       timestamptz   not null,
  primary key (venue, venue_order_id)
);
create index if not exists venue_orders_intent_idx on venue_orders (client_intent_id);
create index if not exists venue_orders_status_idx on venue_orders (status, updated_at desc);

-- Append-only order-event log. NEVER rewrite an order row to erase
-- history — write an event and project venue_orders off it.
create table if not exists venue_order_events (
  id             uuid        primary key default gen_random_uuid(),
  venue          text        not null,
  venue_order_id text        not null,
  event_type     text        not null check (event_type in (
    'submitted', 'acknowledged', 'partial_fill', 'fill',
    'cancel_requested', 'canceled', 'rejected', 'expired'
  )),
  occurred_at    timestamptz not null,
  payload        jsonb       not null default '{}'::jsonb
);
create index if not exists venue_order_events_order_idx
  on venue_order_events (venue, venue_order_id, occurred_at);

-- Individual fills.
create table if not exists venue_fills (
  venue          text          not null,
  venue_order_id text          not null,
  venue_fill_id  text          not null,
  occurred_at    timestamptz   not null,
  price          numeric(20,10) not null,
  quantity       numeric(30,10) not null,
  fee            numeric(30,10) not null default 0,
  liquidity      text          not null check (liquidity in ('maker', 'taker')),
  primary key (venue, venue_fill_id)
);
create index if not exists venue_fills_order_idx on venue_fills (venue, venue_order_id, occurred_at);

-- Per-outcome inventory. shares is signed.
create table if not exists venue_positions (
  venue            text          not null,
  account_id       text          not null,
  condition_id     text          not null,
  outcome_token_id text          not null,
  shares           numeric(30,10) not null,
  cost_basis       numeric(30,10) not null default 0,
  updated_at       timestamptz   not null default now(),
  primary key (venue, account_id, condition_id, outcome_token_id)
);

-- Point-in-time account snapshots (collateral + in-flight reservations).
create table if not exists account_snapshots (
  id                 uuid        primary key default gen_random_uuid(),
  venue              text        not null,
  account_id         text        not null,
  collateral_balance numeric(30,10) not null,
  open_intent_count  integer     not null default 0,
  open_order_count   integer     not null default 0,
  connectivity       text        not null default 'ok' check (connectivity in ('ok', 'degraded', 'down')),
  captured_at        timestamptz not null default now()
);
create index if not exists account_snapshots_idx on account_snapshots (venue, account_id, captured_at desc);

-- Risk-engine snapshots — the bounded-worst-case exposure state at each
-- decision, kept for audit + the Risk tab.
create table if not exists risk_snapshots (
  id                    uuid        primary key default gen_random_uuid(),
  captured_at           timestamptz not null default now(),
  bounded_worst_case_usd numeric(30,10),
  daily_loss_usd        numeric(30,10),
  open_order_reserve_usd numeric(30,10),
  state                 text        not null,   -- RUNNING | PAUSE_NEW_ENTRIES | REDUCE_ONLY | ...
  detail                jsonb       not null default '{}'::jsonb
);
create index if not exists risk_snapshots_idx on risk_snapshots (captured_at desc);

-- Immutable operator-action audit log. Every control-plane action
-- (kill/pause/preset change) writes one row. Append-only by convention;
-- no updates/deletes.
create table if not exists operator_actions (
  id          uuid        primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor       text        not null,
  action      text        not null,
  detail      jsonb       not null default '{}'::jsonb
);
create index if not exists operator_actions_idx on operator_actions (occurred_at desc);

-- Liveness heartbeats per process (web/executor/worker commands).
create table if not exists process_heartbeats (
  process     text        primary key,
  last_beat   timestamptz not null default now(),
  detail      jsonb       not null default '{}'::jsonb
);

-- Reconciliation run history + open breaks (venue-truth vs local state).
create table if not exists reconciliation_runs (
  id          uuid        primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  completed_at timestamptz,
  scope       text        not null,   -- 'orders' | 'positions' | 'fills'
  breaks_found integer    not null default 0
);
create index if not exists reconciliation_runs_idx on reconciliation_runs (started_at desc);

create table if not exists reconciliation_breaks (
  id          uuid        primary key default gen_random_uuid(),
  run_id      uuid,
  detected_at timestamptz not null default now(),
  scope       text        not null,
  venue_order_id text,
  description text        not null,
  resolved_at timestamptz,
  detail      jsonb       not null default '{}'::jsonb
);
create index if not exists reconciliation_breaks_open_idx
  on reconciliation_breaks (resolved_at nulls first, detected_at desc);

-- Realtime publication for the dashboard-facing execution read-models.
do $$
declare
  t text;
  pub_tables text[] := array[
    'venue_orders', 'venue_fills', 'venue_positions',
    'reconciliation_breaks', 'process_heartbeats'
  ];
begin
  foreach t in array pub_tables loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when others then null; end;
  end loop;
end $$;

-- RLS.
do $$
declare
  t text;
  anon_tables text[] := array[
    'venue_orders', 'venue_fills', 'venue_positions', 'account_snapshots',
    'risk_snapshots', 'reconciliation_runs', 'reconciliation_breaks',
    'process_heartbeats', 'operator_actions'
  ];
  deny_tables text[] := array['execution_intents', 'venue_order_events'];
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
  foreach t in array deny_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon read %1$s" on %1$I', t);
    -- Explicit privilege revoke, not just "no grant": supabase/postgres
    -- sets ALTER DEFAULT PRIVILEGES so tables created by supabase_admin
    -- are auto-granted to anon/authenticated. Without this revoke the
    -- deny-list tables would be anon-readable on any Supabase deployment.
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
