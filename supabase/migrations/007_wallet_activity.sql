-- ────────────────────────────────────────────────────────────────────────────
-- PR 2 / 007 — Wallet identity + activity (raw intel)
--
-- Additive. wallets/candidates/relationships/venue_trades. This is raw
-- alpha: the whole point of the platform. It is NOT anon-readable and NOT
-- realtime-published. The dashboard reads derived, non-sensitive views
-- (tiers, anomalies) via later migrations; the raw layer is service-role
-- only. When the Wallets tab lands it reads through an authenticated
-- server route, never the browser anon key.
--
-- wallet_candidates is added now (first used in PR 4) — same domain, cheap.
--
-- -- Down: drop table venue_trades, wallet_relationships, wallet_candidates,
-- --       wallets cascade;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Chain-level wallet identity. chain_id + address is the natural key
-- (Polygon = 137). known_entity_type is nullable until roles are resolved.
create table if not exists wallets (
  chain_id          integer     not null,
  address           text        not null,
  first_seen        timestamptz,
  last_seen         timestamptz,
  is_contract       boolean     not null default false,
  known_entity_type text,       -- 'proxy' | 'signer' | 'deposit' | 'safe' | 'funder' | ...
  primary key (chain_id, address)
);

-- Discovery funnel queue. A wallet enters as a candidate (cheap seed),
-- gets a materiality priority, and is promoted to full backfill.
create table if not exists wallet_candidates (
  id             uuid        primary key default gen_random_uuid(),
  chain_id       integer     not null,
  address        text        not null,
  source         text        not null,          -- 'leaderboard' | 'top-holder' | 'large-trade' | ...
  priority_score double precision not null default 0,
  first_seen     timestamptz not null default now(),
  promoted_at    timestamptz,
  unique (chain_id, address, source)
);
create index if not exists wallet_candidates_priority_idx
  on wallet_candidates (promoted_at nulls first, priority_score desc);

-- Confidence-weighted edges. NEVER asserts shared ownership — the
-- relationship_type + confidence + evidence are probabilistic. Mirrors
-- the contracts' wallet_relationships model.
create table if not exists wallet_relationships (
  id                uuid        primary key default gen_random_uuid(),
  chain_id          integer     not null,
  wallet_a          text        not null,
  wallet_b          text        not null,
  relationship_type text        not null,        -- 'direct_transfer' | 'shared_funder' | 'synchronized' | ...
  score             double precision not null,
  confidence        double precision not null check (confidence >= 0 and confidence <= 1),
  first_seen        timestamptz,
  last_seen         timestamptz,
  evidence          jsonb       not null default '{}'::jsonb,
  model_version     text        not null
);
create index if not exists wallet_relationships_a_idx on wallet_relationships (chain_id, wallet_a);
create index if not exists wallet_relationships_b_idx on wallet_relationships (chain_id, wallet_b);

-- Normalized venue trades. source_trade_id is unique per venue; where a
-- source has no stable id, the ingest layer synthesizes a canonical
-- dedupe hash and stores it here. price/quantity/notional are numeric
-- (never float).
create table if not exists venue_trades (
  id               uuid          primary key default gen_random_uuid(),
  source_trade_id  text          not null,
  venue            text          not null,
  wallet           text          not null,
  condition_id     text          not null,
  outcome_token_id text          not null,
  side             text          not null check (side in ('BUY', 'SELL')),
  price            numeric(20,10) not null,
  quantity         numeric(30,10) not null,
  notional         numeric(30,10) not null,
  occurred_at      timestamptz   not null,
  tx_hash          text,
  maker_taker      text          check (maker_taker in ('maker', 'taker')),
  raw_object_id    uuid,
  unique (venue, source_trade_id)
);
create index if not exists venue_trades_wallet_idx on venue_trades (wallet, occurred_at desc);
create index if not exists venue_trades_market_idx on venue_trades (condition_id, occurred_at desc);
create index if not exists venue_trades_tx_idx on venue_trades (tx_hash);

-- RLS. All four tables are raw intel → RLS on, NO anon policy (deny).
do $$
declare
  t text;
  deny_tables text[] := array[
    'wallets', 'wallet_candidates', 'wallet_relationships', 'venue_trades'
  ];
begin
  foreach t in array deny_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon read %1$s" on %1$I', t);
  end loop;
end $$;
