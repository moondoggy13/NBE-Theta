-- ────────────────────────────────────────────────────────────────────────────
-- PR 7 / 015 — The selection layer: cohort, clusters, copyability, policy
--
-- Additive. This is the layer that decides WHOM we follow, so everything
-- downstream inherits its quality. See docs/adr/0002-overlord-copy-trading.md.
--
--   event_classifications      — is this event sports? Versioned, because a
--                                reclassification must be auditable rather
--                                than silently rewriting history.
--   wallet_copyability_snapshots
--                              — can a source's entries actually be
--                                mirrored? The dimension the skill scorer
--                                does not measure at all.
--   wallet_clusters / _members — wallets that trade as one entity.
--   scoring_policies           — the versioned, approved rule set. Every
--                                cohort decision cites the policy that
--                                produced it.
--   wallet_cohort              — membership + eligibility state + why.
--
-- Security: all five are alpha internals / control plane → RLS on, NO anon
-- policy, explicit revoke (mirrors 007 and 011). The console reads them
-- through server-side service-role routes.
--
-- -- Down: drop table wallet_cohort, wallet_clusters_members,
-- --       wallet_clusters, wallet_copyability_snapshots,
-- --       event_classifications, scoring_policies cascade;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- ── Event taxonomy ────────────────────────────────────────────────────
-- V1 copies non-sports markets only. That makes "is this sports?" a
-- trading gate, not a label, so it is stored explicitly with the
-- classifier version that decided it.
--
-- `is_sports` is deliberately NOT nullable-as-unknown. Three states are
-- needed and conflating them is how an unclassified event slips into a
-- non-sports cohort: true / false / and the absence of a row, which means
-- "never classified". A wallet or market with no classification row is
-- NOT eligible — we cannot assert non-sports from silence.
create table if not exists event_classifications (
  venue              text        not null default 'polymarket',
  venue_event_id     text        not null,
  classifier_version text        not null,
  is_sports          boolean     not null,
  category           text,
  -- What the classifier matched on, so a wrong call can be diagnosed
  -- without re-running it.
  evidence           jsonb       not null default '{}'::jsonb,
  classified_at      timestamptz not null default now(),
  primary key (venue, venue_event_id, classifier_version)
);
create index if not exists event_classifications_sports_idx
  on event_classifications (is_sports, classifier_version);

-- ── Copyability ───────────────────────────────────────────────────────
-- The keystone measurement. A wallet can be genuinely skilled and
-- completely uncopyable: it trades thin books, its own entry moves the
-- price, and by the time we observe the fill the edge has gone. Skill
-- scoring cannot see this, because skill is measured at the price the
-- SOURCE paid and copyability is about the price WE would pay.
--
-- All columns are nullable: a wallet whose markets have no quote history
-- is UNMEASURED, not uncopyable. The difference decides whether we go
-- collect more data or drop the wallet, so it must survive into the table.
create table if not exists wallet_copyability_snapshots (
  id                   uuid          primary key default gen_random_uuid(),
  wallet               text          not null,
  as_of                timestamptz   not null,
  model_version        text          not null,
  -- Assumed detection+execution delay the measurement simulates.
  delay_seconds        integer       not null,
  -- Entries with enough quote coverage to evaluate at all.
  n_entries            integer       not null default 0,
  n_measured           integer       not null default 0,
  -- THE headline number: share of measured entries a copier arriving
  -- `delay_seconds` later could have filled inside the price cap.
  copyable_fraction    double precision,
  -- Mean signed price move against a copier over the delay window, in
  -- probability units. Positive = the price ran away from us.
  adverse_drift        double precision,
  median_slippage      double precision,
  median_spread        double precision,
  median_depth_usd     numeric(30,10),
  -- Composite in [0,1]. Derived, stored so a tier decision is
  -- reproducible without recomputing the inputs.
  copyability          double precision
    check (copyability is null or (copyability >= 0 and copyability <= 1)),
  rationale            jsonb         not null default '{}'::jsonb,
  unique (wallet, as_of, model_version, delay_seconds)
);
create index if not exists wallet_copyability_wallet_idx
  on wallet_copyability_snapshots (wallet, as_of desc);

-- ── Correlated wallet clusters ────────────────────────────────────────
-- Five wallets run by one desk are ONE opinion. Without this, "two
-- independent sources agree" is a false statement that doubles our size
-- on a single source.
create table if not exists wallet_clusters (
  id              uuid        primary key default gen_random_uuid(),
  model_version   text        not null,
  as_of           timestamptz not null,
  -- Stable label within (model_version, as_of); cluster ids are not
  -- comparable across runs because membership can change.
  cluster_key     text        not null,
  size            integer     not null,
  -- Strongest pairwise co-activity inside the cluster, for triage.
  max_pair_score  double precision,
  evidence        jsonb       not null default '{}'::jsonb,
  unique (model_version, as_of, cluster_key)
);

create table if not exists wallet_cluster_members (
  cluster_id uuid not null references wallet_clusters(id) on delete cascade,
  wallet     text not null,
  primary key (cluster_id, wallet)
);
create index if not exists wallet_cluster_members_wallet_idx
  on wallet_cluster_members (wallet);

-- ── Scoring / eligibility policy ──────────────────────────────────────
-- Versioned and content-hashed. A cohort decision that cannot name the
-- rules that produced it is not auditable, and "we changed a threshold and
-- forgot" is the most likely way this system quietly starts following the
-- wrong wallets.
--
-- `approved_at` null = candidate. The active policy is the most recently
-- approved one; a candidate can be evaluated by walk-forward without ever
-- being allowed to select the live feeder set.
create table if not exists scoring_policies (
  id            uuid        primary key default gen_random_uuid(),
  version       text        not null unique,
  policy_hash   text        not null,
  params        jsonb       not null,
  notes         text,
  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  approved_by   text,
  -- Set when a later policy supersedes this one; keeps history intact
  -- instead of mutating the row.
  retired_at    timestamptz
);
create index if not exists scoring_policies_approved_idx
  on scoring_policies (approved_at desc nulls last);

-- ── Cohort membership ─────────────────────────────────────────────────
-- status:
--   'candidate' — in the observed universe, not yet eligible.
--   'cohort'    — passed eligibility; tracked at the slow poll cadence.
--   'feeder'    — actively mirrored; fast poll cadence. Bounded set.
--   'excluded'  — failed a veto or was manually denied. Kept, not deleted,
--                 so an exclusion is visible rather than an absence.
--
-- `checks` records every gate outcome. This table answers "why is this
-- wallet (not) being followed?" without re-deriving anything, which is the
-- question an operator actually asks.
create table if not exists wallet_cohort (
  wallet            text        not null,
  as_of             timestamptz not null,
  policy_version    text        not null,
  status            text        not null
    check (status in ('candidate', 'cohort', 'feeder', 'excluded')),
  cluster_key       text,
  skill_score       double precision,
  copyability       double precision,
  -- Composite used only for RANKING within an already-eligible set.
  -- Eligibility itself is decided by the vetoes in `checks`, never by
  -- this number crossing a threshold — see ADR-0002 section A on why a
  -- weighted sum compared to a magic constant is the wrong shape.
  rank_score        double precision,
  rank              integer,
  n_active_days     integer,
  n_closed_markets  integer,
  traded_notional   numeric(30,10),
  checks            jsonb       not null default '{}'::jsonb,
  reason            text,
  primary key (wallet, as_of, policy_version)
);
create index if not exists wallet_cohort_status_idx
  on wallet_cohort (as_of desc, status, rank);
create index if not exists wallet_cohort_wallet_idx
  on wallet_cohort (wallet, as_of desc);

-- ── RLS ───────────────────────────────────────────────────────────────
-- Alpha internals + control plane → deny anon/authenticated entirely.
do $$
declare
  t text;
  deny_tables text[] := array[
    'event_classifications',
    'wallet_copyability_snapshots',
    'wallet_clusters',
    'wallet_cluster_members',
    'scoring_policies',
    'wallet_cohort'
  ];
begin
  foreach t in array deny_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon read %1$s" on %1$I', t);
    -- Explicit revoke, not merely "no grant": supabase/postgres sets
    -- ALTER DEFAULT PRIVILEGES so tables created by supabase_admin are
    -- auto-granted to anon/authenticated. Without this these would be
    -- anon-readable on any Supabase deployment.
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
