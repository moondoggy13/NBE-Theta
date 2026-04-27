-- ────────────────────────────────────────────────────────────────────────────
-- Stage 12 / Phase 1 — Quantitative Master Architecture
--
-- Three new tables for the regime classifier + IC-weighted master signal.
-- All are read by the dashboard via the Realtime publication.
-- ────────────────────────────────────────────────────────────────────────────

-- Per-candle filtered HMM posterior over R=3 regimes (bull/range/bear).
create table if not exists regime_posteriors (
  id              bigserial    primary key,
  ts              timestamptz  not null,
  symbol          text         not null default 'BTC-USD',
  p_bull          numeric(10,8) not null,
  p_range         numeric(10,8) not null,
  p_bear          numeric(10,8) not null,
  dominant_state  text         not null check (dominant_state in ('bull','range','bear')),
  realized_vol    numeric(18,8),
  log_return      numeric(18,8)
);
create index if not exists regime_posteriors_ts_idx
  on regime_posteriors (symbol, ts desc);

-- Rolling K×R weight matrix for the master signal. Each row is one cell
-- (strategy, regime) at a snapshot ts; updated weekly.
create table if not exists master_weights (
  id            bigserial    primary key,
  ts            timestamptz  not null,
  strategy_id   text         not null,
  regime        text         not null check (regime in ('bull','range','bear')),
  weight        numeric(10,8) not null,
  ic            numeric(10,8),         -- Spearman IC at this snapshot
  ic_std        numeric(10,8),         -- rolling std of IC
  sample_size   integer,
  unique (ts, strategy_id, regime)
);
create index if not exists master_weights_ts_idx
  on master_weights (ts desc, strategy_id);

-- Validation metrics from the CPCV / DSR / PBO pipeline (Phase 2).
-- Phase 1 leaves this empty; the worker reads the latest row per
-- (strategy_id, regime) and treats absence as "not yet validated → use
-- equal-weight warmup default".
create table if not exists strategy_validation (
  id            bigserial    primary key,
  computed_at   timestamptz  not null default now(),
  strategy_id   text         not null,
  regime        text         not null check (regime in ('bull','range','bear')),
  dsr           numeric(10,8),         -- Deflated Sharpe Ratio
  pbo           numeric(10,8),         -- Probability of Backtest Overfitting
  sharpe        numeric(10,8),         -- raw Sharpe for reference
  sample_size   integer,
  notes         text
);
create index if not exists strategy_validation_latest_idx
  on strategy_validation (strategy_id, regime, computed_at desc);

-- Realtime publication so the dashboard can stream regime + weights live.
do $$
begin
  -- Idempotent adds — supabase_realtime publication already exists.
  begin
    alter publication supabase_realtime add table regime_posteriors;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table master_weights;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table strategy_validation;
  exception when others then null; end;
end $$;

-- RLS + anon read policies (matches the pattern from migration 003)
do $$
declare
  t text;
  tables text[] := array['regime_posteriors', 'master_weights', 'strategy_validation'];
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'drop policy if exists "anon read %1$s" on %1$I; '
      || 'create policy "anon read %1$s" on %1$I for select to anon using (true);',
      t
    );
  end loop;
end $$;
