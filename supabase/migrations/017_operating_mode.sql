-- ────────────────────────────────────────────────────────────────────────────
-- PR 9 / 017 — Operating mode
--
-- Additive. Three states, and they are genuinely different rather than a
-- boolean dressed up:
--
--   'paused' — evaluate nothing. The pipeline stops at detection.
--   'shadow' — evaluate everything, simulate fills, place no orders.
--   'live'   — dispatch real orders. Requires the three-flag env gate,
--              two-step operator confirmation, AND a documented
--              compliance approval. This column is necessary for live,
--              never sufficient.
--
-- Default is 'shadow', not 'paused'. A system that silently stops
-- evaluating looks identical to one with no signals, and the whole point
-- of the shadow period is to accumulate the rejection histogram — so the
-- safe default is the one that keeps measuring while trading nothing.
--
-- Lives on `risk_state` because that is the surviving venue-neutral
-- control plane (see CLAUDE.md: risk_state is the one pre-pivot table
-- retained deliberately, and /api/kill-switch owns it). A separate
-- table would create two places to look for "are we trading?", which is
-- exactly the question that must have one answer.
--
-- `mode_changed_by` / `_at` are denormalised from operator_actions on
-- purpose: the audit log is the record, but a console rendering the
-- current banner should not have to scan an append-only table to answer
-- "who put us in this state, and when".
--
-- -- Down: alter table risk_state drop column mode,
-- --       drop column mode_changed_at, drop column mode_changed_by;
-- ────────────────────────────────────────────────────────────────────────────

alter table risk_state
  add column if not exists mode text not null default 'shadow'
    check (mode in ('paused', 'shadow', 'live'));

alter table risk_state
  add column if not exists mode_changed_at timestamptz;

alter table risk_state
  add column if not exists mode_changed_by text;

-- Existing row predates the column; make its state explicit rather than
-- leaving the default to imply an operator chose it.
update risk_state
   set mode_changed_at = coalesce(mode_changed_at, now()),
       mode_changed_by = coalesce(mode_changed_by, 'migration-017')
 where id = 1;
