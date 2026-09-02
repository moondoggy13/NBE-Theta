# NBE-Theta — Polymarket Quant Copy-Trading Platform

Systematic copy trading of skilled Polymarket traders. Discover wallets,
measure their forecasting edge against the prices they actually paid,
and — only after that edge survives out-of-sample validation — mirror it
through an independently risk-gated executor.

> **Status — research/shadow only. No live trading.** All three layers
> are built and tested, but the executor has never sent an order to a
> venue: it runs against a CLOB simulator, and the live adapter refuses
> to construct unless three environment flags are set together. The alpha
> hypothesis has **not** been validated against real data (see "The alpha
> gate" below), and nothing goes live before that, a passed shadow gate,
> and a documented compliance review.

The pre-pivot BTC/Coinbase system has been **deleted** from this
repository. It survives only behind the git tag `btc-v1-final`. See
`docs/adr/0001-polymarket-pivot.md`.

## Architecture — three layers

| Layer | Where | Status |
|---|---|---|
| **Intelligence** — market registry, wallet discovery, trade history, live position + leaderboard monitoring, CLOB market data, (later) chain enrichment | `python/nbe_theta/{ingest,ledger}` | built |
| **Signal** — position reconstruction, skill scoring, significance, tiering, walk-forward | `python/nbe_theta/{analytics,backtest}` | built |
| **Execution** — per-instrument locks, durable intent outbox, CLOB simulator, reconciliation | `apps/executor`, `packages/execution-domain` | built, **shadow only** |

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
uv run theta-market-data run           # stream the CLOB book → market_quotes
uv run theta-market-data backfill <tok> --condition-id 0x…
                                       # fill quote history for a past market

# Signal
uv run theta-score-wallets score --as-of 2027-06-01T00:00:00Z
uv run theta-score-wallets walkforward --start ... --end ...
uv run theta-signals summary           # fill rate + rejection histogram
uv run theta-signals gate              # the promotion decision packet
uv run theta-signals gate --record     # …and persist it (required for live)

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
everyone, and that is a stop.** It has still not been run against real
data — every Polymarket host is unreachable from CI — so the whole stack
below it remains an instrument awaiting its measurement.

The second, equally decisive number is the **qualified-signal fill rate**
from `theta-signals summary`: copying is a latency race, and identifying
a good trader is worth nothing if we cannot get their price.

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

## The shadow gate

Before any real order, the shadow period has to produce a passing
decision packet. `theta-signals gate --record` evaluates a trailing
window against the six criteria from ADR-0002 and writes the verdict to
`shadow_gate_runs`:

```
  [PASS] window_duration               31  (bar 30)
  [PASS] qualified_signal_count       140  (bar 100)
  [----] net_positive_after_costs      n/a
         most opened lots have not settled
  [PASS] detection_freshness_p95      40.0  (bar 90)
  [PASS] zero_duplicate_orders           0  (bar 0)
  [PASS] zero_unresolved_incidents       0  (bar 0)
```

`----` is neither pass nor fail: the criterion could not be measured
yet, and it blocks promotion exactly as a failure does. **That third
state is the point.** Over an empty window "zero duplicate orders" and
"zero unresolved incidents" are both trivially true, and a two-valued
gate would read four vacuous truths and let a system with no track
record promote itself. See `docs/adr/0003-shadow-gate-enforcement.md`.

`/api/console/mode` refuses to set mode to `live` unless a packet with
verdict `pass` exists, and fails closed if it cannot tell.

## Safety

Four conditions stand between this repository and a real order. Three
are machine-checked; the fourth is deliberately not.

1. **Operator confirmation** — `/api/console/mode` requires
   `confirm: "ENABLE-LIVE"` alongside the mode. Enforced.
2. **The three-flag env gate** — all of
   `EXECUTION_PROVIDER=polymarket-clob`, `POLYMARKET_LIVE=true`,
   `CONFIRM_LIVE=YES`, checked when the venue adapter is *constructed*,
   not when it submits. CI never sets any of them. Enforced.
3. **A passing shadow gate** — a recorded `shadow_gate_runs` row with
   verdict `pass`. Enforced (ADR-0003).
4. **A documented legal/compliance approval** for the operating
   jurisdiction. **Not** modelled as a boolean, on purpose: a checkbox
   would let one click stand in for a legal opinion, and would look
   identical whether or not anyone had read one.

Also:

- No private key in the web process or in CI.
- Raw wallet-intelligence tables are service-role only — never exposed
  through anonymous RLS.
- Control routes (`/api/kill-switch`, `/api/watchlist`, `/api/console/*`)
  are bearer-gated and write an `operator_actions` audit row. The gate is
  a shared secret, not identity — rotating it is the only revocation
  mechanism: `docs/runbooks/rotate-control-api-token.md`.
- See `AGENTS.md` for the full development contract.

## Docs

- `docs/adr/0001-polymarket-pivot.md` — why the pivot, and the rollout order
- `docs/adr/0002-overlord-copy-trading.md` — the copy-trading spec, its
  corrections, and the PR roadmap
- `docs/adr/0003-shadow-gate-enforcement.md` — why the promotion gate has
  three outcomes per criterion instead of two
- `AGENTS.md` — development contract (boundaries, migrations, tests, don'ts)
- `CLAUDE.md` — repo navigation + what never to reintroduce
- `python/README.md` — worker commands and layout
- `packages/contracts/README.md` — contract generation
