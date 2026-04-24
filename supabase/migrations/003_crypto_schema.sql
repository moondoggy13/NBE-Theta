-- ────────────────────────────────────────────────────────────────────────────
-- NBE-Theta → BTC quant schema
-- Wipes the equity template schema (migrations 001 & 002) and installs a
-- time-series + order-shaped schema oriented around a single instrument
-- (BTC-USD) on Coinbase Advanced Trade.
-- ────────────────────────────────────────────────────────────────────────────

-- Drop equity tables (safe if already gone)
drop table if exists signal_events            cascade;
drop table if exists signal_scores            cascade;
drop table if exists sentiment_embeddings     cascade;
drop table if exists trades                   cascade;
drop table if exists positions                cascade;
drop table if exists pnl_snapshots            cascade;
drop table if exists portfolio_state          cascade;
drop table if exists pipeline_runs            cascade;
drop table if exists macro_indicators         cascade;
drop table if exists claude_analysis_runs     cascade;

-- Keep pgcrypto + pgvector available (pgvector for future ML research)
create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ────────────────────────────────────────────────────────────────────────────
-- Candles (OHLCV, normalized across intervals)
-- ────────────────────────────────────────────────────────────────────────────
create table candles (
  symbol    text        not null,
  interval  text        not null check (interval in ('1m','5m','15m','1h','4h','1d')),
  ts        timestamptz not null,
  o         numeric(18,8) not null,
  h         numeric(18,8) not null,
  l         numeric(18,8) not null,
  c         numeric(18,8) not null,
  v         numeric(24,8) not null,
  primary key (symbol, interval, ts)
);
create index candles_ts_desc_idx on candles (symbol, interval, ts desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Ticks (raw trade prints; high-volume — consider retention policy)
-- ────────────────────────────────────────────────────────────────────────────
create table ticks (
  id       bigserial primary key,
  symbol   text        not null,
  ts       timestamptz not null,
  price    numeric(18,8) not null,
  size     numeric(24,8) not null,
  side     text        not null check (side in ('buy','sell'))
);
create index ticks_symbol_ts_idx on ticks (symbol, ts desc);

-- ────────────────────────────────────────────────────────────────────────────
-- L2 order-book snapshots (sampled, not per-event)
-- ────────────────────────────────────────────────────────────────────────────
create table l2_snapshots (
  id     bigserial primary key,
  symbol text        not null,
  ts     timestamptz not null,
  bids   jsonb       not null,           -- [[price, size], ...]
  asks   jsonb       not null
);
create index l2_snapshots_symbol_ts_idx on l2_snapshots (symbol, ts desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Strategy signals (one row per strategy evaluation)
-- ────────────────────────────────────────────────────────────────────────────
create table strategy_signals (
  id           uuid        primary key default gen_random_uuid(),
  symbol       text        not null,
  strategy_id  text        not null,
  ts           timestamptz not null,
  side         text        not null check (side in ('long','short','flat')),
  score        numeric(6,4) not null,   -- -1..+1
  confidence   numeric(6,4) not null,   --  0..1
  features     jsonb       not null default '{}'::jsonb,
  entry_hint   jsonb                     -- { price, stop, target }
);
create index strategy_signals_ts_idx on strategy_signals (symbol, strategy_id, ts desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Orders (all modes: backtest / paper / live)
-- ────────────────────────────────────────────────────────────────────────────
create table orders (
  id                 uuid         primary key default gen_random_uuid(),
  coinbase_order_id  text         unique,
  mode               text         not null check (mode in ('backtest','paper','live')),
  strategy_id        text,
  symbol             text         not null,
  side               text         not null check (side in ('buy','sell')),
  type               text         not null check (type in ('market','limit','stop','stop_limit')),
  qty                numeric(24,8) not null,
  price              numeric(18,8),             -- null for market orders
  status             text         not null check (status in ('pending','submitted','partial','filled','canceled','rejected','expired')),
  submitted_at       timestamptz  not null default now(),
  filled_at          timestamptz,
  filled_qty         numeric(24,8) not null default 0,
  filled_price       numeric(18,8),
  fees               numeric(18,8) not null default 0,
  meta               jsonb        not null default '{}'::jsonb
);
create index orders_mode_status_idx on orders (mode, status, submitted_at desc);
create index orders_strategy_idx on orders (strategy_id, submitted_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Fills (each fill against an order)
-- ────────────────────────────────────────────────────────────────────────────
create table fills (
  id         uuid         primary key default gen_random_uuid(),
  order_id   uuid         not null references orders(id) on delete cascade,
  ts         timestamptz  not null default now(),
  price      numeric(18,8) not null,
  qty        numeric(24,8) not null,
  liquidity  text         check (liquidity in ('maker','taker')),
  fee        numeric(18,8) not null default 0
);
create index fills_order_idx on fills (order_id, ts);

-- ────────────────────────────────────────────────────────────────────────────
-- Positions (BTC-only v1 — single row per symbol)
-- ────────────────────────────────────────────────────────────────────────────
create table positions (
  symbol           text          primary key,
  qty              numeric(24,8) not null default 0,
  avg_entry        numeric(18,8) not null default 0,
  unrealized_pnl   numeric(18,8) not null default 0,
  realized_pnl     numeric(18,8) not null default 0,
  opened_at        timestamptz,
  updated_at       timestamptz   not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- P&L snapshots (time-series equity curve)
-- ────────────────────────────────────────────────────────────────────────────
create table pnl_snapshots (
  id             bigserial    primary key,
  ts             timestamptz  not null default now(),
  equity         numeric(18,8) not null,
  realized       numeric(18,8) not null default 0,
  unrealized     numeric(18,8) not null default 0,
  drawdown_pct   numeric(8,4)  not null default 0
);
create index pnl_snapshots_ts_idx on pnl_snapshots (ts desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Risk state (single row, kill switch + daily bookkeeping)
-- ────────────────────────────────────────────────────────────────────────────
create table risk_state (
  id                    integer     primary key default 1 check (id = 1),
  kill_switch_active    boolean     not null default false,
  autonomous_execution  boolean     not null default false,
  preset                text        not null default 'Aggressive' check (preset in ('Conservative','Moderate','Aggressive','Custom')),
  daily_loss_dollars    numeric(18,8) not null default 0,
  daily_start_equity    numeric(18,8) not null default 25000,
  day_anchor_utc        date        not null default (now() at time zone 'utc')::date,
  updated_at            timestamptz not null default now()
);
insert into risk_state (id) values (1) on conflict (id) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- Backtest runs (results of JS or Python backtests)
-- ────────────────────────────────────────────────────────────────────────────
create table backtest_runs (
  id            uuid         primary key default gen_random_uuid(),
  engine        text         not null check (engine in ('ts','python')),
  strategy_id   text         not null,
  symbol        text         not null default 'BTC-USD',
  interval      text         not null default '1m',
  params        jsonb        not null default '{}'::jsonb,
  from_ts       timestamptz  not null,
  to_ts         timestamptz  not null,
  metrics       jsonb        not null default '{}'::jsonb,   -- Sharpe, Sortino, maxDD, hitRate, turnover, trades, pnl
  started_at    timestamptz  not null default now(),
  completed_at  timestamptz,
  notes         text
);
create index backtest_runs_strategy_idx on backtest_runs (strategy_id, started_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- System logs (pino → here, filtered by component)
-- ────────────────────────────────────────────────────────────────────────────
create table system_logs (
  id         bigserial    primary key,
  ts         timestamptz  not null default now(),
  level      text         not null check (level in ('trace','debug','info','warn','error','fatal')),
  component  text         not null,
  message    text         not null,
  payload    jsonb
);
create index system_logs_ts_idx on system_logs (ts desc);
create index system_logs_level_idx on system_logs (level, ts desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Realtime publication (dashboard-critical tables)
-- ────────────────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table positions;
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table fills;
alter publication supabase_realtime add table strategy_signals;
alter publication supabase_realtime add table pnl_snapshots;
alter publication supabase_realtime add table risk_state;
alter publication supabase_realtime add table system_logs;
