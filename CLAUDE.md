@AGENTS.md

# CLAUDE.md — Repository navigation notes

Everything in `AGENTS.md` applies. The additions below are things I
(the assistant) will benefit from having close at hand when navigating
this repo.

## Where things live

- **ADRs**: `docs/adr/000N-*.md`. The pivot is ADR-0001.
- **Runbooks**: `docs/runbooks/*.md` — populated as we ship each
  process. Kill-switch drill, executor recovery, chain-reorg replay,
  DR restore all belong here.
- **Contracts**: `packages/contracts` — Pydantic models with generated
  JSON Schema and TS. Any durable payload (execution intent, signal
  envelope, venue order event) is defined here first.
- **Python worker**: `python/nbe_theta` — one package, several commands
  (`theta-registry`, `theta-wallet-backfill`, `theta-score-wallets`).
- **Migrations**: `supabase/migrations/NNN_*.sql`, additive only.
- **Frozen BTC system**: git tag `btc-v1-final`. Every BTC/Coinbase
  artifact was deleted from the working tree in the "purge BTC trading
  code" commit; that tag is the ONLY place it still exists.

## The BTC system is gone — do not resurrect it

The repository is now exclusively a Polymarket copy-trading platform.
There is no `worker/`, no `src/lib/{broker,feed,signals,regime,risk,
backtest,redis}`, no Coinbase adapter, no OHLC strategies, no
`ONCHAIN_THETA_AGENT/`. If a task seems to want one of those, the
answer is a Polymarket-native equivalent, not a restoration.

Specifically, do NOT reintroduce:

- A `BrokerClient`-shaped interface (buy/sell, one symbol, one
  position). Prediction markets need `PredictionMarketVenue` in
  `packages/execution-domain` — condition ids, outcome tokens, separate
  YES/NO inventory, limit-only primitives, TIF.
- `COINBASE_*` env vars or an `isLiveEnabled()` keyed to them. The live
  gate is `EXECUTION_PROVIDER=polymarket-clob && POLYMARKET_LIVE=true
  && CONFIRM_LIVE=YES`.
- Candle/OHLC-shaped strategy interfaces. Signals derive from wallet
  skill (`python/nbe_theta/analytics`), not price series.
- A single global `inFlight` mutex. Per-instrument locks
  (`venue + account + condition_id + outcome_token_id`) replace it.

The BTC *tables* are still in the database — deleting code is
reversible, dropping tables is not, so they follow the two-step rule in
`AGENTS.md`. Migration `013_retire_btc_tables.sql` did step 1: it
revoked anon read and pulled them out of `supabase_realtime`, so
nothing reaches them any more, but the rows are intact. They are
`candles`, `ticks`, `l2_snapshots`, `strategy_signals`, `orders`,
`fills`, `positions`, `pnl_snapshots`, `backtest_runs`, `system_logs`,
`regime_posteriors`, `master_weights`, `strategy_validation`, and
`claude_analyses`. Do not write to them, and do not name them in new
code — if a new feature wants "orders", it means `venue_orders`.

`risk_state` is the exception: it survives, it is live, and
`/api/kill-switch` owns it.

## Bug history worth carrying forward

The deleted `worker/execution.ts` earned these the hard way (v1 → v3);
the new execution coordinator must satisfy them as regression tests,
not inherit the code:

- v1: fee bleed from short cooldown + 50bp stop.
- v2: async race — 4 close orders in 1 ms flipped a position into a
  57× leveraged runaway long that lost $29 k on a 1.94 % drop. Root
  cause: sync check + async submit + shared mutable state + a mock
  broker with no buying-power enforcement.
- v3: synchronous lock before any await, per-tick reconciliation vs
  broker truth, flatten-on-kill, `onFill` truth updates.

Regression tests for the PR-8 coordinator MUST exercise the v2 race
(multiple concurrent triggers racing an async venue call) against
per-instrument locks and the CLOB simulator.

## Common tasks in this repo

- Add a domain type → edit `packages/contracts/nbe_theta_contracts/*.py`
  → `pnpm contracts:generate`. Do not edit generated files.
- Add a migration → new file `supabase/migrations/NNN_*.sql`, additive
  only. See migration rules in `AGENTS.md`.
- Add an ingest source → new module under `python/nbe_theta/ingest/`
  behind the `Fetcher` seam, with recorded-fixture replay tests.
- Add a signal strategy → new module under
  `python/nbe_theta/signals/strategies/`; emits the standard signal
  envelope from `packages/contracts`.
- Add a venue adapter → implement `PredictionMarketVenue` in
  `packages/execution-domain`.

## Analytics invariants (PR 5) — do not weaken

These are enforced by tests and each one guards a way the pipeline
would otherwise manufacture false alpha:

- Skill is `payoff − entry price − fees`, never hit rate.
- An episode is unscoreable until its market SETTLES, even one the
  wallet exited months earlier.
- The bootstrap refuses below 3 event clusters (one cluster resamples
  to itself → zero-width interval → infinite apparent certainty).
- Unresolved outcomes are dropped, never imputed.
- Tier A requires an out-of-sample window.
- **A missing price is `None`, never `0.0`.** "Unmeasured" and "no edge"
  are different claims; conflating them dilutes a real edge and makes
  thin quote coverage look like mediocrity. `clv` and `markout_*` stay
  SQL NULL when there is no price history.
- **Every historical price lookup is clamped to `as_of`.** Markouts and
  CLV read `market_quotes` through `QuoteLookup`, which takes an `as_of`
  ceiling. Do not add a lookup that skips it because "the caller already
  filtered" — that assumption is what produced the settlement leak.

## Market data (PR 6) — the two things not to undo

- **`BookState.synced` is load-bearing.** A delta feed is only
  meaningful on top of a known-current snapshot. Anything that could
  have lost a message (reconnect, malformed delta, crossed book) clears
  the flag, and an unsynced book emits NO quotes until a REST snapshot
  restores it. Going quiet is correct: a missing quote is visible in the
  freshness metrics, a wrong one is invisible and poisons every markout
  derived from it.
- **Resync applies the FULL book, not the top of it.** Rebuilding from
  best-bid/best-ask alone looks right until the venue deletes that
  level, at which point the view falls through to whatever arrives next
  instead of the real next-best price.

## The shadow gate (PR 11) — the third state is load-bearing

`python/nbe_theta/signals/gate.py` judges the promotion criteria, and
every criterion returns one of **three** outcomes: `pass`, `fail`,
`insufficient_evidence`. Do not collapse that to a boolean, and do not
add a criterion that returns only two.

The reason is arithmetic, not taste. Over a window in which the system
has done nothing: "zero duplicate orders" is true, "zero unresolved
incidents" is true, a net P&L of exactly zero is not negative, and a p95
over an empty list is whatever the default says. A two-valued gate reads
four vacuous truths and promotes a system with no track record to live
trading. `zero_unresolved_incidents` is the single deliberate exception
— "nothing is broken" is a real answer even over an empty window, and it
is also the only criterion not scoped to the window.

Related invariants:

- **`/api/console/mode` refuses `live` without a recorded
  `shadow_gate_runs` row whose verdict is `pass`.** It fails closed on a
  query error. This is a risk gate: changing it needs an ADR, a
  `risk-gate-*.test.ts`, and review by someone other than the author.
- **Verdict precedence is `fail` > `insufficient_evidence` > `pass`.**
- **P&L counts settled and closed lots only.** Never mark open lots to
  market — that is the same rule as "an episode is unscoreable until its
  market settles", applied to the promotion decision.
- **p95 is nearest-rank, never interpolated.** Interpolation invents a
  latency below the real 95th observation, biasing towards passing.
- **Compliance approval is not a boolean and must not become one.** A
  stored `true` looks identical whether or not anyone read a legal
  opinion.

## Operator identity (PR 12) — what must not regress

`src/lib/auth.ts` is the auth boundary. Changing it needs an ADR, a
`risk-gate-*.test.ts`, and review by someone other than the author.

- **A valid Supabase session is authentication, not authorisation.** The
  `operator_accounts` row is the grant. Never treat a verified user
  without a row as an operator — that would make the project's signup
  page the access control.
- **Roles ascend: `viewer` < `operator` < `admin`.** Promotion to live
  requires `admin`; the kill switch deliberately requires only
  `operator`, because needing the highest privilege to *stop* trading
  would be backwards.
- **The shared token is capped at `operator`** and must stay incapable of
  arming live trading. `CONTROL_API_TOKEN_ROLE=admin` exists but is a
  deliberate, written-down override — never a default.
- **`operator_actions.actor` comes from the verified principal, never
  the request body.** It used to come from the body, which meant the
  audited party wrote their own log entry. Use `auditFields(principal)`
  so actor, user id, email and auth method always travel together.
- **Fail closed on every branch**, and keep 503 for "a mechanism exists
  and could not be reached" — a wrong credential is 401, so outages are
  not buried under bad-password noise.
- **`operator_actions` is anon-denied** as of migration 019; it carries
  operator emails. Do not re-grant it.

## Non-goals (do not scope-creep)

- No polymarket.com browser-driver strategy.
- No multi-chain support.
- No Kalshi / non-Polymarket venue implementation.
- No Redis.
- No LLM-based signal ideation until PR 10.
- No historical Polygon backfill until wallet alpha is validated
  (PR 5 gate).
