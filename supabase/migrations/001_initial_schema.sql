-- NB&E Triangle Trading System — Initial Schema
-- Supabase PostgreSQL 17 with pgvector

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ──────────────────────────────────────────────────────────────────────
-- Pipeline runs (one row per day per stage)
-- ──────────────────────────────────────────────────────────────────────
create table pipeline_runs (
  id            uuid primary key default gen_random_uuid(),
  run_date      date not null,
  stage_id      text not null,
  status        text not null default 'pending',
  started_at    timestamptz,
  completed_at  timestamptz,
  logs          text[] not null default '{}',
  error_message text,
  created_at    timestamptz not null default now(),
  constraint pipeline_runs_stage_check
    check (stage_id in (
      'premarket_pull','claude_analysis','signal_crossref',
      'universe_finalization','execution','regime_check','eod_review'
    )),
  constraint pipeline_runs_status_check
    check (status in ('pending','active','completed','error')),
  unique (run_date, stage_id)
);

-- ──────────────────────────────────────────────────────────────────────
-- Signal scores (one row per ticker per run_date)
-- ──────────────────────────────────────────────────────────────────────
create table signal_scores (
  id                uuid primary key default gen_random_uuid(),
  run_date          date not null,
  ticker            text not null,
  name              text not null,
  sector            text,
  market_cap        bigint,
  avg_volume        bigint,
  current_price     numeric(12,4),
  catalyst_score    smallint not null default 0,
  catalyst_signals  text[] not null default '{}',
  technical_score   smallint not null default 0,
  technical_signals text[] not null default '{}',
  options_score     smallint not null default 0,
  options_signals   text[] not null default '{}',
  sentiment_score   smallint not null default 0,
  sentiment_signals text[] not null default '{}',
  economic_score    smallint not null default 0,
  economic_signals  text[] not null default '{}',
  conviction_score  smallint not null default 0,
  in_universe       boolean not null default false,
  catalyst_text     text,
  updated_at        timestamptz not null default now(),
  unique (run_date, ticker)
);

-- ──────────────────────────────────────────────────────────────────────
-- Sentiment embeddings (pgvector — replaces ChromaDB)
-- ──────────────────────────────────────────────────────────────────────
create table sentiment_embeddings (
  id          uuid primary key default gen_random_uuid(),
  ticker      text not null,
  content     text not null,
  source      text not null,
  embedding   vector(1536),
  created_at  timestamptz not null default now()
);
create index sentiment_embeddings_idx on sentiment_embeddings
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ──────────────────────────────────────────────────────────────────────
-- Positions (open paper positions)
-- ──────────────────────────────────────────────────────────────────────
create table positions (
  id                   uuid primary key default gen_random_uuid(),
  ticker               text not null unique,
  name                 text not null,
  shares               numeric(10,4) not null,
  entry_price          numeric(12,4) not null,
  current_price        numeric(12,4) not null,
  stop_loss            numeric(12,4) not null,
  target               numeric(12,4) not null,
  pnl_dollars          numeric(12,4) not null default 0,
  pnl_percent          numeric(8,4) not null default 0,
  conviction_at_entry  smallint not null,
  entered_at           timestamptz not null,
  status               text not null default 'active',
  constraint positions_status_check
    check (status in ('active','watching','exiting'))
);

-- ──────────────────────────────────────────────────────────────────────
-- Trades (closed positions — immutable log)
-- ──────────────────────────────────────────────────────────────────────
create table trades (
  id                   uuid primary key default gen_random_uuid(),
  ticker               text not null,
  side                 text not null default 'long',
  entry_price          numeric(12,4) not null,
  exit_price           numeric(12,4) not null,
  shares               numeric(10,4) not null,
  pnl_dollars          numeric(12,4) not null,
  pnl_percent          numeric(8,4) not null,
  entered_at           timestamptz not null,
  exited_at            timestamptz not null,
  hold_time_minutes    integer not null,
  conviction_at_entry  smallint not null,
  exit_reason          text not null,
  constraint trades_side_check check (side in ('long','short')),
  constraint trades_exit_check check (exit_reason in ('target','stop_loss','manual','eod'))
);

-- ──────────────────────────────────────────────────────────────────────
-- Intraday PnL snapshots
-- ──────────────────────────────────────────────────────────────────────
create table pnl_snapshots (
  id           uuid primary key default gen_random_uuid(),
  captured_at  timestamptz not null,
  pnl_dollars  numeric(12,4) not null,
  run_date     date not null default current_date
);
create index pnl_snapshots_run_date_idx on pnl_snapshots(run_date, captured_at);

-- ──────────────────────────────────────────────────────────────────────
-- Signal events feed
-- ──────────────────────────────────────────────────────────────────────
create table signal_events (
  id          uuid primary key default gen_random_uuid(),
  ticker      text not null,
  layer       text not null,
  message     text not null,
  impact      text not null default 'neutral',
  occurred_at timestamptz not null default now(),
  run_date    date not null default current_date,
  constraint signal_events_layer_check
    check (layer in ('catalyst','technical','options_flow','sentiment','economic')),
  constraint signal_events_impact_check
    check (impact in ('bullish','bearish','neutral'))
);
create index signal_events_run_date_idx on signal_events(run_date, occurred_at desc);

-- ──────────────────────────────────────────────────────────────────────
-- Portfolio state (single-row updated during market hours)
-- ──────────────────────────────────────────────────────────────────────
create table portfolio_state (
  id                  uuid primary key default gen_random_uuid(),
  total_value         numeric(14,4) not null,
  cash_available      numeric(14,4) not null,
  day_pnl_dollars     numeric(12,4) not null,
  day_pnl_percent     numeric(8,4) not null,
  total_pnl_dollars   numeric(12,4) not null,
  total_pnl_percent   numeric(8,4) not null,
  position_count      smallint not null,
  max_positions       smallint not null,
  kill_switch_active  boolean not null default false,
  updated_at          timestamptz not null default now()
);

-- Enable Realtime on dashboard-critical tables
alter publication supabase_realtime add table pipeline_runs;
alter publication supabase_realtime add table signal_events;
alter publication supabase_realtime add table positions;
alter publication supabase_realtime add table portfolio_state;
