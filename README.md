# NBE-Theta — Polymarket Quant Copy-Trading Platform

Systematic copy trading of skilled Polymarket traders. Discover wallets,
measure their forecasting edge against the prices they actually paid,
and — only after that edge survives out-of-sample validation — mirror it
through an independently risk-gated executor.

> **Status — research/paper only. No live trading.** The Intelligence
> and Signal layers are built and tested; the Execution layer is not
> written yet. The alpha hypothesis has **not** been validated against
> real data (see "The alpha gate" below), and live CLOB execution stays
> off behind a three-flag gate until it is.

The pre-pivot BTC/Coinbase system has been **deleted** from this
repository. It survives only behind the git tag `btc-v1-final`. See
`docs/adr/0001-polymarket-pivot.md`.

## Architecture — three layers

| Layer | Where | Status |
|---|---|---|
| **Intelligence** — market registry, wallet discovery, trade history, live position + leaderboard monitoring, (later) chain enrichment | `python/nbe_theta/{ingest,ledger}` | built |
| **Signal** — position reconstruction, skill scoring, significance, tiering, walk-forward | `python/nbe_theta/{analytics,backtest}` | built |
| **Execution** — durable intent outbox, CLOB adapter, portfolio risk, reconciliation | `apps/executor` | **not built** (PR 8) |

Supporting: `packages/contracts` (Pydantic → JSON Schema → TypeScript,
the single source of truth for durable payloads), `supabase/migrations`
(additive-only), and a Next.js dashboard whose **Smart Money** cockpit
shows the leader roster, a conviction board plotting every tracked entry
against the current price, and the live tape.

The tiers on that cockpit come from a **leaderboard-PnL prior** today,
not from the validated scorer. The statistical tiering described below
only starts labelling wallets once the alpha gate has been run for real.

## Commands

```bash
pnpm install                  # node deps
cd python && uv sync --extra dev   # python worker deps

# Intelligence
uv run theta-registry run              # sweep Gamma → market registry
uv run theta-wallet-backfill seed      # leaderboards/holders → candidates
uv run theta-wallet-backfill run       # backfill wallet trade history
uv run theta-live-monitor run          # steady state: watchlist → positions
                                       #   → leaderboard → heartbeat
uv run theta-live-monitor watch 0x…    # add one wallet to the watchlist

# Signal
uv run theta-score-wallets score --as-of 2027-06-01T00:00:00Z
uv run theta-score-wallets walkforward --start ... --end ...

# Infra
docker compose up -d db       # local Postgres (supabase/postgres image)
pnpm migrate up               # apply migrations from zero
pnpm dev                      # dashboard on :4200
```

## The alpha gate

`theta-score-wallets walkforward` is the decision point the whole plan
is organized around. It scores wallets using only information available
at each historical date, then measures what those wallets actually did
next, and reports:

```
lift (selected − universe baseline)
```

**A non-positive lift means wallet selection adds nothing over trading
everyone, and that is a stop** — replan before investing in the chain
indexer (PR 7) or the execution stack (PR 8). Building this measurement
*before* the expensive infrastructure is the point.

## What the scoring layer refuses to do

Each of these is enforced by a test, and each guards a specific way the
pipeline would otherwise manufacture false alpha:

- **Hit rate is never skill.** Buying a 0.90 favorite and winning is not
  edge. The primary metric is `payoff − entry price − fees`.
- **Many fills are one decision.** Episodes, not fills, are the unit of
  observation.
- **Correlated markets are not independent evidence.** The bootstrap
  resamples whole event clusters, and refuses below three of them.
- **An episode is unscoreable until its market settles** — even one the
  wallet exited months earlier.
- **Unresolved outcomes are dropped, never imputed.**
- **Tier A requires an out-of-sample window.** It is the only tier the
  executor may ever act on.

## Safety

- Live execution requires all three of `EXECUTION_PROVIDER=polymarket-clob`,
  `POLYMARKET_LIVE=true`, `CONFIRM_LIVE=YES`. CI never sets any of them.
- No private key in the web process or in CI.
- Raw wallet-intelligence tables are service-role only — never exposed
  through anonymous RLS.
- Control routes (`/api/kill-switch`, `/api/watchlist`) are bearer-gated
  and write an `operator_actions` audit row.
- See `AGENTS.md` for the full development contract.

## Docs

- `docs/adr/0001-polymarket-pivot.md` — why the pivot, and the rollout order
- `AGENTS.md` — development contract (boundaries, migrations, tests, don'ts)
- `CLAUDE.md` — repo navigation + what never to reintroduce
- `python/README.md` — worker commands and layout
- `packages/contracts/README.md` — contract generation
