-- ────────────────────────────────────────────────────────────────────────────
-- PR 16 / 021 — Constrain venue_orders.status to the contract
--
-- Additive (a CHECK constraint; no column or table is altered
-- destructively). Safe to add unconditionally because `venue_orders` has
-- never been written: PR 16 introduces its first writer, so there are no
-- existing rows a new constraint could reject. That is verified by the
-- migration itself below rather than assumed.
--
-- WHY: three vocabularies currently describe an order's status, and they
-- disagree.
--
--   packages/contracts (Pydantic, the source of truth per AGENTS.md):
--     pending, signed, submitted, live, partially_filled,
--     cancel_pending, canceled, filled, rejected, expired
--
--   packages/execution-domain (hand-written TypeScript):
--     pending, live, partially_filled, filled, canceled, rejected,
--     expired, UNKNOWN
--
--   venue_orders.status: `text`, unconstrained — anything at all.
--
-- `unknown` is the important difference. The venue interface requires
-- implementations to surface an ambiguous submit — a timeout, a reset,
-- an ambiguous 5xx — as `status: "unknown"`, precisely so the caller
-- reconciles instead of retrying. That is a correct in-memory state and
-- a incoherent durable one: a `venue_orders` row asserts that an order
-- exists, and on an ambiguous submit we do not know that. Recording it
-- would convert "we must go and find out" into "we have an order in
-- state unknown", which is a claim nobody verified.
--
-- So an ambiguous submit opens a `reconciliation_breaks` row instead,
-- and this constraint makes that structural: the schema simply will not
-- accept `unknown`, whatever a future writer intends.
--
-- -- Down: alter table venue_orders drop constraint venue_orders_status_check;
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  offending int;
begin
  -- Prove the premise rather than trusting it. If a row ever did carry a
  -- status outside the contract, adding the constraint would abort the
  -- migration with a constraint-violation message that says nothing
  -- about why; this says why.
  select count(*) into offending
    from venue_orders
   where status not in (
     'pending', 'signed', 'submitted', 'live', 'partially_filled',
     'cancel_pending', 'canceled', 'filled', 'rejected', 'expired'
   );

  if offending > 0 then
    raise exception
      'venue_orders holds % row(s) with a status outside the contract; '
      'reconcile them before constraining the column', offending;
  end if;
end $$;

alter table venue_orders
  drop constraint if exists venue_orders_status_check;

alter table venue_orders
  add constraint venue_orders_status_check check (status in (
    'pending', 'signed', 'submitted', 'live', 'partially_filled',
    'cancel_pending', 'canceled', 'filled', 'rejected', 'expired'
  ));

comment on column venue_orders.status is
  'Order status, constrained to the contract OrderStatus. Deliberately '
  'excludes the execution-domain''s in-memory "unknown": an ambiguous '
  'submit means we cannot assert an order exists, so it opens a '
  'reconciliation_breaks row rather than an order row. See ADR-0008.';
