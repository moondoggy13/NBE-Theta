-- ────────────────────────────────────────────────────────────────────────────
-- PR 14 / 020 — Claims become leases
--
-- Additive. Fixes a way execution intents are lost silently.
--
-- `CLAIM_SQL` moves a row to `status='claimed'` in a COMMITTED update, and
-- it only ever selects rows `where status='ready'`. So if the claiming
-- worker dies after that commit — a crash, an OOM kill, a deploy, a
-- container reschedule — the row sits in `claimed` and **nothing will
-- ever pick it up again**. No error, no break row, no alert: the intent
-- simply never executes.
--
-- The outbox module's own docstring said a dying worker "releases its
-- lock when its transaction aborts". That is true only for a worker that
-- dies BEFORE the claim commits. After the commit there is no
-- transaction and no lock — double-claim protection comes from the
-- status value, not from `FOR UPDATE SKIP LOCKED` — so the ordinary
-- crash case is exactly the one that was unhandled.
--
-- For a copy-trading system this is the worst-shaped failure available:
-- the operator believes a wallet is being mirrored, and silently it is
-- not. A stranded intent is invisible in a way a rejected one is not.
--
-- The fix is to make a claim a LEASE rather than a permanent transition.
-- A claim now carries an expiry; a reaper returns expired claims to
-- `ready`. See `RECLAIM_SQL` in apps/executor/src/outbox.ts and
-- docs/adr/0006-intent-leases.md.
--
-- -- Down: alter table execution_intents drop column lease_expires_at;
-- ────────────────────────────────────────────────────────────────────────────

-- Nullable, and deliberately so. Rows claimed before this migration have
-- no lease, and inventing one would be asserting something nobody
-- recorded. They are handled explicitly by the reaper (see the partial
-- index note below) rather than by a backfilled guess.
alter table execution_intents
  add column if not exists lease_expires_at timestamptz;

-- The reaper's supporting index.
--
-- Partial on `status = 'claimed'` because that is the only status it
-- ever scans, and the table is dominated by terminal rows in steady
-- state. `nulls first` so pre-migration claims — which have no lease and
-- are therefore the ones most likely to be already stranded — sort to
-- the front of the operator's view when they investigate.
create index if not exists execution_intents_lease_idx
  on execution_intents (lease_expires_at nulls first)
  where status = 'claimed';

comment on column execution_intents.lease_expires_at is
  'When this claim stops being valid. A worker that dies after claiming '
  'leaves the row in status=claimed forever; the reaper returns rows past '
  'this instant to status=ready. NULL means a claim made before migration '
  '020, which the reaper treats as already expired.';
