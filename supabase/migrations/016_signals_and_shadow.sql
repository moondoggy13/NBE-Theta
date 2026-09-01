-- ────────────────────────────────────────────────────────────────────────────
-- PR 8 / 016 — Signal qualification, strategy lots, shadow execution
--
-- Additive. This is the layer that turns "a wallet we follow just traded"
-- into "here is what we would have done, and why". It produces the
-- evidence the 30-day shadow gate consumes.
--
--   source_actions     — many source fills folded into ONE decision.
--   signal_evaluations — every evaluation, accepted or not, with all gate
--                        outcomes and the policy version.
--   strategy_lots      — our positions, attributed to the source that
--                        caused them.
--   shadow_fills       — what a bounded FOK order would have done against
--                        the real book.
--
-- Security: alpha internals + simulated portfolio → RLS on, NO anon
-- policy, explicit revoke (mirrors 007, 011, 015).
--
-- -- Down: drop table shadow_fills, strategy_lots, signal_evaluations,
-- --       source_actions cascade;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Source actions ────────────────────────────────────────────────────
-- A wallet scaling into a position over four minutes produces several
-- fills and made ONE decision. Copying each fill independently would
-- multiply our exposure by the number of fills — the same error the
-- episode model already fixes for scoring, applied to live detection.
--
-- `position_before` / `position_after` are the source's own exposure
-- either side of the action. Materiality is measured against them
-- (a $250 trade means something different to a $5k account than to a
-- $5m one), and exit mirroring needs the ratio, not the absolute size.
create table if not exists source_actions (
  id                  uuid           primary key default gen_random_uuid(),
  wallet              text           not null,
  condition_id        text           not null,
  outcome_token_id    text           not null,
  side                text           not null check (side in ('BUY', 'SELL')),
  -- Deterministic identity over the grouped fills, so a re-poll of an
  -- overlapping window cannot create a second action for the same
  -- decision. This is the dedupe the whole live path depends on.
  dedupe_key          text           not null unique,
  n_fills             integer        not null default 1,
  quantity            numeric(30,10) not null,
  notional            numeric(30,10) not null,
  vwap                numeric(20,10) not null,
  position_before     numeric(30,10),
  position_after      numeric(30,10),
  first_fill_at       timestamptz    not null,
  last_fill_at        timestamptz    not null,
  -- When WE saw it. `last_fill_at` is the venue's clock; detection
  -- latency is the difference, and it is the number that decides whether
  -- a copy was ever realistic.
  detected_at         timestamptz    not null default now(),
  created_at          timestamptz    not null default now()
);
create index if not exists source_actions_wallet_idx
  on source_actions (wallet, last_fill_at desc);
create index if not exists source_actions_detected_idx
  on source_actions (detected_at desc);

-- ── Signal evaluations ────────────────────────────────────────────────
-- EVERY evaluation lands here, accepted or rejected. The reject histogram
-- is the single most valuable output of shadow mode: if 90% of signals
-- die on `price_cap`, the finding is that we cannot win the latency race
-- — which is a product answer, not a bug. Storing only accepted signals
-- would hide exactly that.
--
-- `gates` holds every gate's outcome; `reject_reason` names the first
-- failure for triage. `policy_version` makes a decision reproducible
-- after a threshold moves.
create table if not exists signal_evaluations (
  id                  uuid           primary key default gen_random_uuid(),
  source_action_id    uuid           references source_actions(id) on delete cascade,
  wallet              text           not null,
  cluster_key         text,
  condition_id        text           not null,
  outcome_token_id    text           not null,
  side                text           not null check (side in ('BUY', 'SELL')),
  evaluated_at        timestamptz    not null default now(),
  policy_version      text           not null,
  accepted            boolean        not null,
  reject_reason       text,
  gates               jsonb          not null default '{}'::jsonb,
  -- What we would have tried, when accepted.
  intended_quantity   numeric(30,10),
  intended_notional   numeric(30,10),
  limit_price         numeric(20,10),
  size_factors        jsonb          not null default '{}'::jsonb,
  detection_latency_s double precision,
  signal_id           uuid,
  unique (source_action_id, policy_version)
);
create index if not exists signal_evaluations_time_idx
  on signal_evaluations (evaluated_at desc);
create index if not exists signal_evaluations_reason_idx
  on signal_evaluations (reject_reason, evaluated_at desc);
create index if not exists signal_evaluations_accepted_idx
  on signal_evaluations (accepted, evaluated_at desc);

-- ── Strategy lots ─────────────────────────────────────────────────────
-- Our positions, attributed to the source that caused them.
--
-- Attribution is what makes exit mirroring correct. When a source cuts
-- 40% of its position we sell 40% of the lots WE opened from that
-- source — not 40% of our total holding in that market, which may
-- include lots from a different source with a different view.
--
-- `mode` separates shadow from live so the two portfolios never mix.
-- A shadow lot must never be counted toward live exposure, and a live
-- lot must never be silently modified by a shadow run.
create table if not exists strategy_lots (
  id                  uuid           primary key default gen_random_uuid(),
  mode                text           not null default 'shadow'
    check (mode in ('shadow', 'live')),
  source_wallet       text           not null,
  source_cluster_key  text,
  source_action_id    uuid           references source_actions(id) on delete set null,
  signal_evaluation_id uuid          references signal_evaluations(id) on delete set null,
  condition_id        text           not null,
  outcome_token_id    text           not null,
  side                text           not null check (side in ('BUY', 'SELL')),
  opened_at           timestamptz    not null,
  entry_price         numeric(20,10) not null,
  quantity_opened     numeric(30,10) not null check (quantity_opened > 0),
  quantity_open       numeric(30,10) not null check (quantity_open >= 0),
  fees_paid           numeric(30,10) not null default 0,
  realized_pnl        numeric(30,10) not null default 0,
  status              text           not null default 'open'
    check (status in ('open', 'closed', 'settled')),
  closed_at           timestamptz,
  -- Set when the market resolved rather than when we sold. Without this
  -- a copied market that settles just leaves an open lot forever and the
  -- book drifts from reality.
  settled_at          timestamptz,
  settlement_price    numeric(20,10)
);
create index if not exists strategy_lots_open_idx
  on strategy_lots (mode, status, condition_id);
create index if not exists strategy_lots_source_idx
  on strategy_lots (mode, source_wallet, outcome_token_id, status);

-- ── Shadow fills ──────────────────────────────────────────────────────
-- What a bounded fill-or-kill order would have done against the book we
-- actually observed.
--
-- `filled` false with a reason is as important as a fill: the fill RATE
-- among qualified signals is a headline result of the shadow gate
-- (ADR-0002 §G). A design that only recorded successes could not report
-- it.
create table if not exists shadow_fills (
  id                   uuid           primary key default gen_random_uuid(),
  signal_evaluation_id uuid           references signal_evaluations(id) on delete cascade,
  strategy_lot_id      uuid           references strategy_lots(id) on delete set null,
  condition_id         text           not null,
  outcome_token_id     text           not null,
  side                 text           not null check (side in ('BUY', 'SELL')),
  attempted_at         timestamptz    not null default now(),
  filled               boolean        not null,
  fill_reason          text,
  requested_quantity   numeric(30,10) not null,
  filled_quantity      numeric(30,10) not null default 0,
  limit_price          numeric(20,10) not null,
  vwap                 numeric(20,10),
  fees                 numeric(30,10) not null default 0,
  -- Cost versus the source's own price, in probability units. The
  -- distribution of this column is what says whether copying is viable.
  slippage_vs_source   numeric(20,10),
  book_snapshot        jsonb          not null default '{}'::jsonb
);
create index if not exists shadow_fills_time_idx on shadow_fills (attempted_at desc);
create index if not exists shadow_fills_filled_idx on shadow_fills (filled, attempted_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────
do $$
declare
  t text;
  deny_tables text[] := array[
    'source_actions', 'signal_evaluations', 'strategy_lots', 'shadow_fills'
  ];
begin
  foreach t in array deny_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon read %1$s" on %1$I', t);
    -- Explicit revoke: supabase/postgres auto-grants new tables to
    -- anon/authenticated via ALTER DEFAULT PRIVILEGES.
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
