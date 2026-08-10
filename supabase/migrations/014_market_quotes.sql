-- ────────────────────────────────────────────────────────────────────────────
-- PR 6 / 014 — Market quote history + latest read-model
--
-- Additive. The Signal layer has two metric families that have been
-- structurally inert since PR 5 because nothing recorded prices over
-- time: closing-line value and markouts (`wallet_score_snapshots.clv`,
-- `.markout_5m/_1h/_24h` are all null today). Both need the same thing —
-- the executable price of an outcome token AT A PAST INSTANT. That is
-- what `market_quotes` is.
--
--   market_quotes       — append-only quote history per outcome token.
--                         The scoring input. One row per observation.
--   market_quote_latest — one row per token, upserted. Dashboard reads +
--                         staleness. Derivable from the history, kept
--                         separate so "what is fresh right now" is an
--                         index lookup rather than a scan of a table
--                         that grows without bound.
--
-- Why numeric, not double precision: these are prices that feed P&L and
-- edge arithmetic. Floats already cost us once (see the `brier_delta`
-- note in PR 5); prices stay exact here and only become floats at the
-- reporting boundary.
--
-- Timestamp discipline. `observed_at` is when WE observed the quote, not
-- a venue-supplied field. It is the only timestamp the no-look-ahead
-- filter may use: a scorer running `as_of = T` must see exactly the
-- quotes that existed at T. `venue_ts` records the venue's own stamp
-- when the message carries one, for latency measurement only — never
-- for observability filtering, because a venue clock we do not control
-- must not decide what our backtest could have known.
--
-- Security: quote data is public venue information (anyone can read the
-- CLOB book), so `market_quote_latest` gets an anon read policy — it is
-- the same class as `markets`/`outcomes` from 005. The full history is
-- service-role only: not because it is secret, but because it is an
-- unbounded time series and a browser-reachable scan of it is a
-- denial-of-service surface, not a feature.
--
-- -- Down: drop table market_quote_latest, market_quotes cascade;
-- --       alter publication supabase_realtime drop table
-- --         market_quote_latest;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Quote history ─────────────────────────────────────────────────────
-- Append-only. One row = one observation of the top of book for one
-- outcome token.
--
-- `source` records HOW the quote arrived, because the two paths have
-- genuinely different trust properties and a reconciliation needs to
-- tell them apart:
--   'ws'           — applied from the market websocket stream.
--   'rest_resync'  — pulled from the REST book after a stream gap. These
--                    are the authoritative repair points; a gap in `ws`
--                    coverage is only safe if a `rest_resync` closes it.
--   'rest_poll'    — routine REST snapshot (no stream running).
--   'rest_history' — backfilled from the venue's own price history.
--                    Load-bearing: without it, CLV and markouts would
--                    only ever exist for episodes that happened AFTER
--                    the collector was first switched on, which is
--                    useless for scoring a wallet's past record. Coarser
--                    than a live quote (one price per bucket, no
--                    bid/ask), so it populates `mid` alone and leaves
--                    the book columns null rather than inventing a
--                    spread.
--
-- bid/ask are nullable on purpose: a one-sided book is a real state, and
-- writing 0 for "no bid" would silently become a 100% spread downstream.
-- `mid` is likewise null when either side is missing — an imputed mid is
-- a fabricated price, and this table feeds skill measurement.
create table if not exists market_quotes (
  id               uuid           primary key default gen_random_uuid(),
  venue            text           not null default 'polymarket',
  condition_id     text           not null,
  outcome_token_id text           not null,
  observed_at      timestamptz    not null,
  venue_ts         timestamptz,
  source           text           not null
    check (source in ('ws', 'rest_resync', 'rest_poll', 'rest_history')),
  best_bid         numeric(20,10) check (best_bid is null or (best_bid >= 0 and best_bid <= 1)),
  best_ask         numeric(20,10) check (best_ask is null or (best_ask >= 0 and best_ask <= 1)),
  mid              numeric(20,10) check (mid is null or (mid >= 0 and mid <= 1)),
  spread           numeric(20,10) check (spread is null or spread >= 0),
  bid_size         numeric(30,10) check (bid_size is null or bid_size >= 0),
  ask_size         numeric(30,10) check (ask_size is null or ask_size >= 0),
  last_trade_price numeric(20,10)
    check (last_trade_price is null or (last_trade_price >= 0 and last_trade_price <= 1)),
  -- Idempotent replay: re-applying the same archived message must not
  -- append a second row. Two genuinely distinct observations of the same
  -- token at the same instant from the same path do not exist.
  unique (outcome_token_id, observed_at, source)
);

-- The markout/CLV lookup is always "the last quote for this token at or
-- before instant X", so token + time descending is the access path.
create index if not exists market_quotes_token_time_idx
  on market_quotes (outcome_token_id, observed_at desc);
create index if not exists market_quotes_market_time_idx
  on market_quotes (condition_id, observed_at desc);

-- ── Latest quote per token ────────────────────────────────────────────
-- Upserted. `observed_at` doubles as the freshness clock: staleness is
-- now() - observed_at, computed by the reader so there is no scheduled
-- job keeping a derived column honest.
--
-- `stream_connected` distinguishes the two ways a quote goes stale —
-- the market went quiet (fine, nothing is trading) versus our collector
-- lost the stream (not fine). A dashboard that cannot tell those apart
-- shows a green light during an outage.
create table if not exists market_quote_latest (
  outcome_token_id text           primary key,
  venue            text           not null default 'polymarket',
  condition_id     text           not null,
  observed_at      timestamptz    not null,
  venue_ts         timestamptz,
  source           text           not null,
  best_bid         numeric(20,10),
  best_ask         numeric(20,10),
  mid              numeric(20,10),
  spread           numeric(20,10),
  bid_size         numeric(30,10),
  ask_size         numeric(30,10),
  last_trade_price numeric(20,10),
  stream_connected boolean        not null default false,
  updated_at       timestamptz    not null default now()
);
create index if not exists market_quote_latest_market_idx
  on market_quote_latest (condition_id);
create index if not exists market_quote_latest_stale_idx
  on market_quote_latest (observed_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────
-- Latest: public market data, anon read (same class as markets/outcomes).
do $$
begin
  execute 'alter table market_quote_latest enable row level security';
  execute 'drop policy if exists "anon read market_quote_latest" on market_quote_latest';
  execute 'create policy "anon read market_quote_latest" on market_quote_latest '
       || 'for select to anon using (true)';
  execute 'grant select on market_quote_latest to anon, authenticated';
end $$;

-- History: service-role only. Not secret — unbounded. See header.
do $$
begin
  execute 'alter table market_quotes enable row level security';
  execute 'drop policy if exists "anon read market_quotes" on market_quotes';
  -- Explicit revoke, not merely "no grant": supabase/postgres sets ALTER
  -- DEFAULT PRIVILEGES so tables created by supabase_admin are
  -- auto-granted to anon/authenticated. Without this the history would
  -- be anon-readable on any Supabase deployment.
  execute 'revoke all on market_quotes from anon, authenticated';
end $$;

-- ── Realtime ──────────────────────────────────────────────────────────
-- Stream the latest read-model (the dashboard wants live prices); never
-- the unbounded history.
do $$
begin
  begin
    execute 'alter publication supabase_realtime add table market_quote_latest';
  exception
    when duplicate_object then null;
    when others then null;
  end;
end $$;
