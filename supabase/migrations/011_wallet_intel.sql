-- ────────────────────────────────────────────────────────────────────────────
-- PR 4 / 011 — Wallet intel: positions, leaderboard, watchlist
--
-- Additive. Supports the wallet-activity ingestors (`theta-wallet-backfill`
-- + `theta-live-monitor`) and the Smart Money dashboard:
--
--   wallet_positions      — current Data-API position snapshot per tracked
--                           wallet × outcome token (full-replace per wallet
--                           on each refresh; captured_at stamps staleness).
--   leaderboard_snapshots — periodic capture of the venue leaderboard
--                           (discovery provenance + wallet-quality prior).
--   wallet_watchlist      — operator-curated control plane: which wallets
--                           the platform actively follows, at what weight.
--   wallets               — gains display columns (Data API exposes
--                           name/pseudonym/avatar; useful in every UI).
--
-- Security: all three new tables are raw intel / control plane → RLS on,
-- NO anon policy, explicit revoke (mirrors 007). The dashboard reads them
-- through server-side service-role routes only.
--
-- -- Down: drop table wallet_watchlist, leaderboard_snapshots,
-- --       wallet_positions cascade;
-- --       alter table wallets drop column display_name, drop column
-- --       pseudonym, drop column profile_image;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Display identity from the Data API (best-effort, refreshed on sight).
alter table wallets add column if not exists display_name  text;
alter table wallets add column if not exists pseudonym     text;
alter table wallets add column if not exists profile_image text;

-- Current positions of tracked wallets, as reported by the Data API
-- /positions endpoint. One row per wallet × outcome token. The ingest
-- layer replaces a wallet's rows atomically per refresh, so a row's
-- absence means "no longer holds it" as of captured_at — no tombstones.
-- Numeric (never float): sizes are shares, *_value/*_pnl are USDC.
create table if not exists wallet_positions (
  wallet           text          not null,
  condition_id     text          not null,
  outcome_token_id text          not null,
  outcome_name     text,
  outcome_index    integer,
  size             numeric(30,10) not null,
  avg_price        numeric(20,10),
  cur_price        numeric(20,10),
  initial_value    numeric(30,10),
  current_value    numeric(30,10),
  cash_pnl         numeric(30,10),
  percent_pnl      numeric(20,10),
  realized_pnl     numeric(30,10),
  total_bought     numeric(30,10),
  redeemable       boolean       not null default false,
  neg_risk         boolean       not null default false,
  title            text,
  slug             text,
  event_slug       text,
  end_date         timestamptz,
  captured_at      timestamptz   not null default now(),
  primary key (wallet, outcome_token_id)
);
create index if not exists wallet_positions_market_idx
  on wallet_positions (condition_id);
create index if not exists wallet_positions_captured_idx
  on wallet_positions (captured_at desc);

-- Periodic leaderboard captures. Append-only; (window, rank_type,
-- captured_at) identifies one sweep. Kept small (top ≤100 per sweep) so
-- history is cheap and wallet-quality priors can look back in time.
create table if not exists leaderboard_snapshots (
  id            uuid          primary key default gen_random_uuid(),
  window_key    text          not null,   -- '1d' | '1w' | '1m' | 'all'
  rank_type     text          not null,   -- 'pnl' | 'vol'
  rank          integer       not null,
  wallet        text          not null,
  amount        numeric(30,10) not null,
  display_name  text,
  pseudonym     text,
  profile_image text,
  captured_at   timestamptz   not null default now()
);
create index if not exists leaderboard_snapshots_sweep_idx
  on leaderboard_snapshots (window_key, rank_type, captured_at desc, rank);
create index if not exists leaderboard_snapshots_wallet_idx
  on leaderboard_snapshots (wallet, captured_at desc);

-- Operator-curated follow list. status:
--   'watch' — track activity + positions, show in Smart Money views.
--   'copy'  — additionally eligible for copy-signal generation (later PR;
--             nothing auto-trades off this today).
--   'mute'  — keep history, hide from views, stop refreshing.
-- weight scales the wallet's contribution to consensus/conviction math.
create table if not exists wallet_watchlist (
  wallet     text             primary key,
  status     text             not null default 'watch'
    check (status in ('watch', 'copy', 'mute')),
  weight     double precision not null default 1.0
    check (weight >= 0 and weight <= 10),
  note       text,
  added_by   text             not null default 'operator',
  added_at   timestamptz      not null default now(),
  updated_at timestamptz      not null default now()
);

-- RLS: raw intel + control plane → deny anon/authenticated entirely.
do $$
declare
  t text;
  deny_tables text[] := array[
    'wallet_positions', 'leaderboard_snapshots', 'wallet_watchlist'
  ];
begin
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
