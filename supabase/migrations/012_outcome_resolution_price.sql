-- ────────────────────────────────────────────────────────────────────────────
-- PR 5 / 012 — Settled outcome prices
--
-- Additive. Scoring needs the realized payoff of each outcome token
-- (0 or 1 for a settled binary market). Without it the whole skill layer
-- is inert: excess edge is `payoff − entry price`, and there is no
-- payoff. Fabricating one would silently corrupt every downstream
-- metric, so the column is nullable and consumers MUST skip outcomes
-- where it is null rather than assume a value.
--
-- Populated by the Gamma registry ingest from `outcomePrices`, and ONLY
-- when the market is resolved — for an active market that same field is
-- the current mid, which is emphatically not a settlement.
--
-- -- Down: alter table outcomes drop column resolution_price;
-- ────────────────────────────────────────────────────────────────────────────

alter table outcomes
  add column if not exists resolution_price numeric(20,10)
    check (resolution_price is null or (resolution_price >= 0 and resolution_price <= 1));

-- Scoring joins outcomes → resolved markets; this supports the lookup.
create index if not exists outcomes_resolution_idx
  on outcomes (venue, venue_market_id)
  where resolution_price is not null;
