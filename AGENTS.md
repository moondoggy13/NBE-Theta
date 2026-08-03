<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# AGENTS.md — Development contract

Read this first. It's shorter than it looks and it will save review
time. Applies to humans, Claude Code, Codex, and any other agent
committing to this repo.

## What this repo is (as of `rebuild/polymarket-v2`)

A Polymarket-focused three-layer platform:

- **Intelligence** (`python/nbe_theta/ingest`, `ledger`, `graph`) —
  collect market/wallet/trade/on-chain data.
- **Signal** (`python/nbe_theta/analytics`, `signals`, `backtest`) —
  score wallets against contemporaneous executable prices; generate
  typed signal envelopes.
- **Execution** (`apps/executor`, `packages/execution-domain`) —
  independently approve and place CLOB orders through a durable
  execution-intent outbox with strict per-instrument locks.

Dashboard is `apps/web` (Next.js). Database is Supabase Postgres.
Nothing else, yet — see the plan in `docs/adr/0001-polymarket-pivot.md`
and the rollout PR list there.

The pre-pivot BTC system has been DELETED from the working tree and
survives only behind the git tag `btc-v1-final`. There is no `worker/`,
no Coinbase adapter, no OHLC strategy layer, no `ONCHAIN_THETA_AGENT/`.
New work does not resurrect any of it — see CLAUDE.md for the specific
things never to reintroduce.

## Project boundaries

- **`apps/web`**: dashboard + authenticated read/control API.
  **Never holds a private key.** Never talks to Polymarket or Polygon
  directly. Talks to Postgres for reads and to internal control routes
  for writes.
- **`apps/executor`**: TypeScript execution service. Holds the signer.
  Claims execution-intent rows transactionally, independently
  re-validates each intent, applies portfolio risk, signs, submits,
  reconciles.
- **`python/nbe_theta`**: single Python package, multiple commands
  (`theta-registry`, `theta-wallet-backfill`, `theta-live-monitor`,
  `theta-score-wallets`, `theta-signal-generator`, `theta-backtest`,
  `theta-chain-enricher`). Shares one `common/` module for config,
  logging, DB, HTTP, retries.
- **`packages/contracts`**: Pydantic → JSON Schema → TypeScript.
  Single source of truth for durable payloads. Every payload pins
  `schema_version`.
- **`packages/execution-domain`**: venue-neutral execution interfaces.
  `PredictionMarketVenue`, `OrderIntent`, `VenuePosition`, TIF enum,
  fee models. Polymarket is the first (and current) implementation.
- **`supabase/migrations`**: additive-only. See "Migrations" below.

## Files that may hold secrets

Never commit any of these:

- `.env`, `.env.local`, `.env.*.local`
- Any file matching `**/signer*.json`, `**/keystore*.json`,
  `**/wallet-secret*`, `**/*.pem`, `**/*.key`
- `apps/executor/.secrets/`
- Any file that ends up under a `secret*/` directory

CI runs a secret scan on every push. Secret material may only appear
inside the executor container as env or mounted volume at runtime.

## Live trading rules

- **Never enable live trading in tests, CI, or local dev without an
  explicit three-flag gate.** The current gate for CLOB is
  `EXECUTION_PROVIDER=polymarket-clob && POLYMARKET_LIVE=true &&
  CONFIRM_LIVE=YES`. All three must be present in the executor's env
  at construction time or the venue adapter refuses to instantiate.
- CI never sets any of the three flags.
- No unit or integration test may place a real order on any venue.
  Tests that exercise the venue adapter must inject a mock or
  record/replay fixture.
- Changes to risk gates require:
  1. an ADR in `docs/adr/`;
  2. a regression test (name it `risk-gate-*.test.ts` or
     `test_risk_gate_*.py`);
  3. code review by someone other than the author.

## Migration rules

- Additive only. `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`, `CREATE
  INDEX`. No `DROP TABLE`, no `DROP COLUMN`, no destructive `ALTER
  COLUMN`, no data-loss-risking `UPDATE` in a migration.
- If you truly need to drop, write two migrations: (1) stop writing to
  the column/table; (2) after ≥ 30 days of the new path working, drop
  in a follow-up migration whose commit message says "APPROVED:
  destructive migration".
- Migration numbers are sequential, no gaps, no reuse. The next
  available number is one higher than the highest existing file in
  `supabase/migrations/`.
- Every migration is reversible if practical. Include a `-- Down:`
  comment describing how to undo, even if we don't automate it.

## Schema-generation rules

- The Python-side Pydantic models in `packages/contracts` are the
  source of truth for durable payloads.
- JSON Schemas are exported at build time to
  `packages/contracts/schemas/`.
- TypeScript types are generated from those JSON Schemas into
  `packages/contracts/generated/ts/`.
- Neither the JSON Schemas nor the generated TS may be edited by hand.
  CI re-runs generation and fails if the diff is non-empty.
- Every durable payload includes `schema_version` as an explicit field
  and every consumer validates against it.

## Truth hierarchy for order state

Order truth is resolved in this order, best first. Never override a
higher source with a lower one.

1. Authenticated venue user stream (fastest).
2. Venue REST order queries (reconciliation).
3. Venue fills / trades.
4. On-chain settlement events.
5. Local intent state (least authoritative).

Order uncertainty (timeout, connection reset, ambiguous 5xx) triggers
reconciliation, not a blind retry.

## Required tests per subsystem

- **Ingest**: for each source, a recorded-fixture replay test that
  exercises pagination edges and dedupe. Cursor-restart tests: kill
  mid-run, restart, assert zero duplicates in normalized tables.
- **Ledger / positions**: property tests that reconstruction against a
  known wallet reconciles within token precision to the Data API.
- **Analytics**: no-look-ahead tests (assert that scoring at
  `as_of=T` used only rows with `occurred_at <= T`); FDR-survivor
  monotonicity; walk-forward persistence checks.
- **Executor**: crash-at-every-transition recovery tests; duplicate
  submit attempts do not duplicate exposure; partial-fill
  reconciliation; cancel-all and pause-new drills; access checks
  fail-closed.
- **Domain contracts**: producer/consumer round-trip fixtures. Mutating
  a field must fail validation.
- **Risk gates**: any change requires a matching regression test.

## Don'ts

- No venue API calls in unit tests. If you need to exercise HTTP, use
  a recorded fixture or a local mock server.
- No destructive migrations without explicit approval in the commit
  message.
- No changes to risk gates without a regression test and an ADR.
- No exposing sensitive tables through anonymous RLS. Every
  browser-reachable route is authenticated and role-checked.
- No private keys in the web process or in CI.
- No LISTEN/NOTIFY as the durable delivery mechanism. Use the
  `execution_intents` outbox with `FOR UPDATE SKIP LOCKED`. NOTIFY is
  a wake-up hint only.

## Commands

- Node: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm build`.
- Python (once `python/nbe_theta` lands in PR 1+): `uv sync --frozen`,
  `uv run ruff check .`, `uv run ruff format --check .`,
  `uv run mypy python/nbe_theta`, `uv run pytest`.
- Docker Compose (local stack): `docker compose up`,
  `docker compose down`, `docker compose exec db psql`.
- Migrations: applied via Supabase CLI or a Docker init script; from
  a clean DB, `pnpm migrate up` applies every file in
  `supabase/migrations/` in order.
