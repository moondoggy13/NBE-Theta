@AGENTS.md

# CLAUDE.md — Repository navigation notes

Everything in `AGENTS.md` applies. The additions below are things I
(the assistant) will benefit from having close at hand when navigating
this repo.

## Where things live

- **Plan**: `/root/.claude/plans/binary-discovering-church.md` — the
  approved rebuild plan. The PR-by-PR rollout order is the
  source-of-truth for what work happens when.
- **ADRs**: `docs/adr/000N-*.md`. The pivot is ADR-0001.
- **Runbooks**: `docs/runbooks/*.md` — populated as we ship each
  process. Kill-switch drill, executor recovery, chain-reorg replay,
  DR restore all belong here.
- **Contracts**: `packages/contracts` — Pydantic models with generated
  JSON Schema and TS. Any durable payload (execution intent, signal
  envelope, venue order event) is defined here first.
- **Frozen BTC state**: git tag `btc-v1-final`. Never resurrect files
  from that tag onto `rebuild/polymarket-v2` without an ADR justifying
  it.

## What existed before the pivot (`btc-v1-final`)

Kept in mind so I don't accidentally re-invent or accidentally use:

- `src/lib/broker/*` — old `BrokerClient` interface (buy/sell, single
  symbol, single position). Do NOT extend for prediction markets — use
  `packages/execution-domain/PredictionMarketVenue` instead.
- `worker/execution.ts` `ExecutionManager` — global `inFlight` mutex,
  single `lastSide`, `positions[0]` reconciliation. Its bug history is
  worth mining for regression tests; its code is not the target of
  reuse. Per-instrument locks replace the global mutex.
- `src/lib/signals/*` — OHLC-shaped strategies. Retained as archived
  reference; not imported by the new signal package.
- `src/lib/regime/gaussian-hmm.ts` — pure math, portable to Python if
  useful for aggregate-universe indicators, but has no default role in
  wallet scoring.
- `src/lib/risk/*` — kill-switch state machine + drawdown brake +
  presets. Concepts kept; implementation rewritten with per-instrument
  and per-event exposure caps.

## Bug history worth carrying forward

From `worker/execution.ts` comments (v1 → v3):

- v1: fee bleed from short cooldown + 50bp stop.
- v2: async race — 4 close orders in 1 ms flipped a position into a
  57× leveraged runaway long that lost $29 k on a 1.94 % BTC drop.
  Root cause: sync check + async submit + shared mutable state
  (`lastSide`) + mock broker with no buying-power enforcement.
- v3: synchronous `inFlight` lock, per-tick reconciliation vs broker
  truth, `flattenAndHalt()` for kill trip, `onFill` truth updates.

Regression tests for the new coordinator MUST exercise the v2 race
pattern (multiple ticks racing an async broker call) against
per-instrument locks and the CLOB simulator.

## Common tasks in this repo

- Add a domain type → edit `packages/contracts/nbe_theta_contracts/*.py`
  → CI regenerates JSON Schema + TS. Do not edit generated files.
- Add a migration → new file `supabase/migrations/NNN_*.sql`, additive
  only. See migration rules in `AGENTS.md`.
- Add a signal strategy → new module under
  `python/nbe_theta/signals/strategies/`; emits the standard signal
  envelope from `packages/contracts`.
- Add a venue adapter → implement
  `PredictionMarketVenue` in `packages/execution-domain`. Do NOT
  extend the deprecated `BrokerClient`.

## Non-goals (do not scope-creep)

- No polymarket.com browser-driver strategy.
- No multi-chain support.
- No Kalshi / non-Polymarket venue implementation.
- No Redis.
- No LLM-based signal ideation until PR 10.
- No historical Polygon backfill until wallet alpha is validated
  (PR 5 gate).
