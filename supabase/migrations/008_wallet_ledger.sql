-- ────────────────────────────────────────────────────────────────────────────
-- PR 2 / 008 — Wallet ledger + episodes (position reconstruction)
--
-- Additive. The double-entry-ish ledger from which positions are
-- reconstructed from first principles (buys/sells/transfers/splits/
-- merges/redemptions), plus the decision-episode grouping. Raw intel →
-- RLS on, no anon.
--
-- cost_basis_quality flags entries whose basis is unknowable (e.g.
-- transferred-in inventory) so scoring can down-weight them rather than
-- silently trusting a wrong number.
--
-- -- Down: drop table wallet_episodes, wallet_ledger_entries cascade;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Per-event share/cash/fee deltas. The unique constraint makes ingest
-- idempotent: the same source row can't produce two ledger entries.
create table if not exists wallet_ledger_entries (
  id                uuid          primary key default gen_random_uuid(),
  wallet            text          not null,
  condition_id      text          not null,
  outcome_token_id  text          not null,
  occurred_at       timestamptz   not null,
  entry_type        text          not null,     -- 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'split' | 'merge' | 'redeem'
  share_delta       numeric(30,10) not null,
  cash_delta        numeric(30,10) not null,
  fee_delta         numeric(30,10) not null default 0,
  source_type       text          not null,     -- 'venue_trade' | 'chain_event'
  source_id         text          not null,
  cost_basis_quality text         not null default 'exact'
    check (cost_basis_quality in ('exact', 'estimated', 'unknown')),
  unique (source_type, source_id, wallet, outcome_token_id, entry_type)
);
create index if not exists wallet_ledger_entries_wallet_idx
  on wallet_ledger_entries (wallet, occurred_at);
create index if not exists wallet_ledger_entries_market_idx
  on wallet_ledger_entries (condition_id, outcome_token_id, occurred_at);

-- Decision episodes: many fills grouped into one trade decision.
-- episode_algorithm_version lets us keep several grouping algorithms and
-- compare stability (no hardcoded cutoff). event_cluster_id ties related
-- markets under one real-world event for correct effective-sample counting.
create table if not exists wallet_episodes (
  id                        uuid          primary key default gen_random_uuid(),
  wallet                    text          not null,
  event_cluster_id          text,
  condition_id              text          not null,
  outcome_token_id          text          not null,
  direction                 text          not null check (direction in ('BUY', 'SELL')),
  opened_at                 timestamptz   not null,
  closed_at                 timestamptz,
  entry_vwap                numeric(20,10),
  exit_vwap                 numeric(20,10),
  maximum_shares            numeric(30,10),
  maximum_cost              numeric(30,10),
  realized_pnl              numeric(30,10),
  resolution_pnl            numeric(30,10),
  status                    text          not null check (status in ('open', 'closed', 'resolved')),
  episode_algorithm_version text          not null
);
create index if not exists wallet_episodes_wallet_idx on wallet_episodes (wallet, opened_at desc);
create index if not exists wallet_episodes_cluster_idx on wallet_episodes (event_cluster_id);
create index if not exists wallet_episodes_market_idx on wallet_episodes (condition_id, outcome_token_id);

-- RLS. Raw intel → RLS on, no anon policy (deny).
do $$
declare
  t text;
  deny_tables text[] := array['wallet_ledger_entries', 'wallet_episodes'];
begin
  foreach t in array deny_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon read %1$s" on %1$I', t);
  end loop;
end $$;
