-- ────────────────────────────────────────────────────────────────────────────
-- PR 11 / 018 — Shadow-gate decision packets
--
-- Additive. One row per evaluation of the promotion gate described in
-- ADR-0002 (spec step 6): thirty days, a hundred qualified signals,
-- net-positive after modelled fees and slippage, p95 detection freshness
-- under ninety seconds, zero duplicate orders, zero unresolved critical
-- incidents.
--
-- Why a table and not a printout: this packet is the artifact that
-- authorises real money. `/api/console/mode` refuses to promote to 'live'
-- unless a passing packet exists here (ADR-0003), which turns condition 4
-- of that route's docstring from a comment into a check. A decision that
-- gates capital has to be durable, timestamped, and attributable to the
-- exact window and policy versions it measured — otherwise "the shadow
-- gate passed" is a claim nobody can audit six months later.
--
-- Rows are INSERT-ONLY by convention. A packet is a measurement of a
-- window, not a mutable status: re-running the gate writes a new row.
-- Editing an old verdict would destroy the audit trail that is the
-- table's whole reason for existing.
--
-- Security: this is alpha-adjacent operational state and it names the
-- conditions under which we would trade. RLS on, NO anon policy, explicit
-- revoke (mirrors 007, 011, 015, 016).
--
-- -- Down: drop table shadow_gate_runs cascade;
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

create table if not exists shadow_gate_runs (
  id                  uuid           primary key default gen_random_uuid(),
  evaluated_at        timestamptz    not null default now(),

  -- The window the packet measured. Stored explicitly rather than
  -- derived from evaluated_at, because a gate re-run over a historical
  -- window is a legitimate thing to do and its verdict must not be
  -- readable as a statement about today.
  window_start        timestamptz    not null,
  window_end          timestamptz    not null,
  check (window_end > window_start),

  -- 'pass' | 'fail' | 'insufficient_evidence'.
  --
  -- Three states, not two, and the third is the important one. A gate
  -- run over four signals that happen to be profitable has not passed
  -- anything; calling that 'pass' is how a system talks itself into
  -- trading on noise. Only 'pass' authorises promotion — see the
  -- partial index below.
  verdict             text           not null
    check (verdict in ('pass', 'fail', 'insufficient_evidence')),

  -- Every criterion's own outcome and the number that decided it, so a
  -- verdict can be explained without re-running anything:
  --   {"net_positive_after_costs": {"status": "pass", "value": 412.83, ...}, ...}
  criteria            jsonb          not null default '{}'::jsonb,

  -- ADR-0002 §G headline: fill rate among qualified signals and the
  -- distribution of rejection reasons. Not a pass/fail criterion — the
  -- spec sets no threshold for it — but it is the finding the shadow
  -- period exists to produce, so it is stored beside the verdict rather
  -- than left to be recomputed from data that may have aged out.
  headline            jsonb          not null default '{}'::jsonb,

  -- Which policy versions were in force during the window. More than one
  -- means the packet measures two different systems averaged together,
  -- which is a caveat an operator must see before acting on it.
  policy_versions     text[]         not null default '{}',

  -- Free-text operator note, e.g. why a run was made or what changed.
  note                text,
  created_by          text           not null default 'theta-signals'
);

create index if not exists shadow_gate_runs_time_idx
  on shadow_gate_runs (evaluated_at desc);

-- The promotion check reads exactly one thing: "is there a passing
-- packet?" A partial index keeps that lookup cheap and, more usefully,
-- makes the privileged subset explicit in the schema.
create index if not exists shadow_gate_runs_pass_idx
  on shadow_gate_runs (evaluated_at desc) where verdict = 'pass';

-- ── RLS ───────────────────────────────────────────────────────────────
do $$
begin
  execute 'alter table shadow_gate_runs enable row level security';
  execute 'drop policy if exists "anon read shadow_gate_runs" on shadow_gate_runs';
  -- Explicit revoke: supabase/postgres auto-grants new tables to
  -- anon/authenticated via ALTER DEFAULT PRIVILEGES, so creating the
  -- table without this leaves it readable by the browser.
  execute 'revoke all on shadow_gate_runs from anon, authenticated';
end $$;
