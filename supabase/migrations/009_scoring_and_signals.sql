-- ────────────────────────────────────────────────────────────────────────────
-- PR 2 / 009 — Wallet scoring + signal outbox (signal-layer outputs)
--
-- Additive. Score/behavior snapshots keep skill and confidence SEPARATE
-- (never collapsed into one number), version every model, and store the
-- rationale so any score is explainable. signals is the SignalEnvelope
-- outbox the dashboard Signals tab reads.
--
-- Security split:
--   anon-read (dashboard-facing, non-sensitive): wallet_tier_snapshots,
--     wallet_anomaly_events, signals.
--   deny (raw alpha internals): wallet_score_snapshots,
--     wallet_behavior_snapshots.
-- Realtime: signals, wallet_tier_snapshots, wallet_anomaly_events.
--
-- -- Down: drop table signals, wallet_tier_snapshots, wallet_anomaly_events,
-- --       wallet_behavior_snapshots, wallet_score_snapshots cascade;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Point-in-time skill snapshot. One row per (wallet, as_of, model). The
-- metric columns mirror the analytics module; unique key enforces
-- walk-forward reproducibility (re-scoring at the same as_of overwrites
-- via upsert, never duplicates).
create table if not exists wallet_score_snapshots (
  id                      uuid          primary key default gen_random_uuid(),
  wallet                  text          not null,
  as_of                   timestamptz   not null,
  model_version           text          not null,
  population_version      text          not null,
  n_fills                 integer       not null default 0,
  n_episodes              integer       not null default 0,
  n_effective_events      double precision,
  posterior_accuracy_mean double precision,
  posterior_accuracy_lcb  double precision,
  mean_excess_edge        double precision,
  edge_lcb                double precision,
  brier_delta             double precision,
  clv                     double precision,
  markout_5m              double precision,
  markout_1h              double precision,
  markout_24h             double precision,
  drawdown                double precision,
  profit_concentration    double precision,
  fdr_q                   double precision,
  out_of_sample_score     double precision,
  skill_score             double precision,
  confidence_score        double precision,
  rationale               jsonb         not null default '{}'::jsonb,
  unique (wallet, as_of, model_version)
);
create index if not exists wallet_score_snapshots_wallet_idx
  on wallet_score_snapshots (wallet, as_of desc);
create index if not exists wallet_score_snapshots_asof_idx
  on wallet_score_snapshots (as_of desc, skill_score desc);

-- Behavior classification snapshot (forecast-specialist / fast-info /
-- quant / market-maker / arbitrageur / copy-trader / new-anomalous).
create table if not exists wallet_behavior_snapshots (
  id            uuid        primary key default gen_random_uuid(),
  wallet        text        not null,
  as_of         timestamptz not null,
  model_version text        not null,
  behavior_class text       not null,
  features      jsonb       not null default '{}'::jsonb,
  unique (wallet, as_of, model_version)
);
create index if not exists wallet_behavior_snapshots_wallet_idx
  on wallet_behavior_snapshots (wallet, as_of desc);

-- Anomaly events (funding-timing, pre-move entry, ...). Evidence, not
-- proof of insider activity — severity is a weight, not a verdict.
create table if not exists wallet_anomaly_events (
  id        uuid        primary key default gen_random_uuid(),
  wallet    text        not null,
  kind      text        not null,
  ts        timestamptz not null,
  severity  double precision not null check (severity >= 0 and severity <= 1),
  evidence  jsonb       not null default '{}'::jsonb
);
create index if not exists wallet_anomaly_events_wallet_idx
  on wallet_anomaly_events (wallet, ts desc);
create index if not exists wallet_anomaly_events_ts_idx
  on wallet_anomaly_events (ts desc);

-- Tier assignment (A validated / B promising / C watch). rationale holds
-- the per-criterion evidence the dashboard shows.
create table if not exists wallet_tier_snapshots (
  id        uuid        primary key default gen_random_uuid(),
  wallet    text        not null,
  as_of     timestamptz not null,
  tier      text        not null check (tier in ('A', 'B', 'C')),
  rationale jsonb       not null default '{}'::jsonb,
  unique (wallet, as_of)
);
create index if not exists wallet_tier_snapshots_wallet_idx
  on wallet_tier_snapshots (wallet, as_of desc);
create index if not exists wallet_tier_snapshots_tier_idx
  on wallet_tier_snapshots (tier, as_of desc);

-- Signal envelope outbox. Mirrors the SignalEnvelope contract; the full
-- payload is also kept as jsonb so the executor and dashboard validate
-- against the versioned schema rather than trusting the flattened cols.
-- The executor does NOT trust maximum_price/maximum_loss_usd as sizing —
-- it recomputes from its own risk snapshot.
create table if not exists signals (
  signal_id        uuid          primary key,
  schema_version   text          not null,
  strategy_type    text          not null,
  venue            text          not null,
  condition_id     text          not null,
  outcome_token_id text          not null,
  direction        text          not null check (direction in ('BUY', 'SELL')),
  maximum_price    numeric(20,10) not null,
  maximum_loss_usd numeric(30,10) not null,
  confidence       double precision not null check (confidence >= 0 and confidence <= 1),
  model_version    text          not null,
  status           text          not null default 'open'
    check (status in ('open', 'consumed', 'expired', 'rejected')),
  expires_at       timestamptz   not null,
  created_at       timestamptz   not null,
  payload          jsonb         not null      -- full SignalEnvelope (evidence, etc.)
);
create index if not exists signals_status_idx on signals (status, created_at desc);
create index if not exists signals_market_idx on signals (condition_id, created_at desc);
create index if not exists signals_expiry_idx on signals (expires_at);

-- Realtime publication for the three dashboard-facing tables.
do $$
declare
  t text;
  pub_tables text[] := array['signals', 'wallet_tier_snapshots', 'wallet_anomaly_events'];
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
  anon_tables text[] := array['signals', 'wallet_tier_snapshots', 'wallet_anomaly_events'];
  deny_tables text[] := array['wallet_score_snapshots', 'wallet_behavior_snapshots'];
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
