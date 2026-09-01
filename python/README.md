# nbe_theta (Python worker)

The Polymarket **Intelligence** and **Signal** layers. One package,
multiple commands, one shared `common/` module (config, logging, db,
http). See `docs/adr/0001-polymarket-pivot.md`.

## Commands

| Command | Status | What it does |
|---|---|---|
| `theta-registry` | PR 3 | Sweep the Gamma API → normalize markets/events/outcomes → version resolution rules → archive raw pages. |
| `theta-wallet-backfill` | PR 4 | `seed`: discover candidates (leaderboards, top holders) → promote by materiality. `run`: backfill Data API trade history into `venue_trades`. |
| `theta-live-monitor` | PR 4b | Always-on loop: watchlist trade sync, position snapshots, leaderboard sweeps, heartbeats. |
| `theta-score-wallets` | PR 5 | `score --as-of`: ledger → episodes → skill metrics → tiers. `walkforward`: rolling out-of-sample evaluation (the alpha gate). |
| `theta-market-data` | PR 6 | `run`: stream the CLOB book for watchlisted markets into `market_quotes`, REST-resyncing after any gap. `backfill`: fill quote history from `/prices-history`. `snapshot`: print one book. |
| `theta-cohort` | **PR 7 (this)** | `classify-events`: sports / non-sports, fail-closed. `cluster`: group wallets that trade as one entity. `select-cohort`: apply eligibility vetoes, promote a bounded feeder set. `show`: the cohort and why. `budget`: polling arithmetic. |
| `theta-signal-generator` | later | Emit typed signal envelopes. |
| … | later | ledger, graph, backtest, chain-enricher. |

## Layout

```
nbe_theta/
├── common/        config, logging (JSON), db (psycopg), http (fetch seam)
└── ingest/
    ├── gamma.py        Gamma client + defensive parsing
    ├── store.py        registry Store ABC + Postgres + InMemory
    ├── registry.py     registry ingestor: sweep → validate → upsert → version
    ├── cli.py          theta-registry entrypoint
    ├── dataapi.py      Data API client + parsing (trades/leaderboard/holders)
    ├── wallet_store.py wallet Store ABC + Postgres + InMemory
    ├── candidates.py   candidate seeding + materiality promotion
    ├── backfill.py     per-wallet trade-history backfill
    ├── ratelimit.py    per-source min-interval budget
    ├── wallet_cli.py   theta-wallet-backfill entrypoint
    ├── clob.py         CLOB REST client + order-book parsing
    ├── marketstream.py market WS seam + book state machine (sync flag)
    ├── collector.py    stream → books → quotes, with REST gap repair
    ├── quote_store.py  quote persistence + historical price lookup
    ├── tokens.py       which outcome tokens to subscribe to
    ├── triggers.py     large-trade / rapid-move ALERTS (never signals)
    ├── market_cli.py   theta-market-data entrypoint
    ├── budget.py       polling-budget arithmetic (ADR-0002 §E)
    └── archive.py      raw-response archive (FS now, R2/S3 later)
analytics/
    ├── taxonomy.py     sports / non-sports, fail-closed
    ├── copyability.py  could we actually have mirrored this wallet?
    ├── clustering.py   wallets that trade as one entity
    ├── cohort.py       eligibility vetoes + bounded feeder set
    ├── cohort_store.py selection-layer persistence
    └── cohort_cli.py   theta-cohort entrypoint
tests/              recorded-fixture replay tests (no live API)
```

## Develop

```
cd python
uv sync --extra dev
uv run ruff check . && uv run ruff format --check .
uv run mypy nbe_theta
uv run pytest                       # DB-backed tests self-skip
DATABASE_URL=postgres://… uv run pytest   # runs the PostgresStore tests too
```

## Run the registry ingestor

```
export DATABASE_URL=postgres://supabase_admin:postgres@localhost:54322/postgres
uv run theta-registry run              # one sweep
uv run theta-registry run --loop       # keep the registry fresh
uv run theta-registry run --max-pages 2   # bounded smoke run
```

Every raw Gamma page is written under `RAW_ARCHIVE_DIR` (default
`./data/raw`) and manifested in `raw_objects`, so the normalized tables
can be re-derived deterministically by re-parsing with a newer
`PARSER_VERSION`.

## Run the wallet ingestor

```
uv run theta-wallet-backfill seed                       # leaderboards → candidates → promote
uv run theta-wallet-backfill seed --market 0xcond…      # also seed that market's top holders
uv run theta-wallet-backfill run                        # backfill promoted wallets
uv run theta-wallet-backfill run --wallet 0xabc… --max-pages 2
```

The Data API gives trades no stable server id, so the parser synthesizes
a deterministic `source_trade_id` from the stable economic fields
(wallet, market, outcome, side, price, size, timestamp, tx hash). The
`unique(venue, source_trade_id)` constraint therefore makes a re-fetched
window a no-op rather than a duplicate — that is what makes a killed
backfill safe to restart.

`DATA_API_MIN_INTERVAL_S` (default 0.2s) throttles calls per source.

## Run the scorer (the alpha gate)

```
uv run theta-score-wallets score --as-of 2027-06-01T00:00:00Z
uv run theta-score-wallets walkforward --start 2027-01-01T00:00:00Z \
                                       --end   2027-06-01T00:00:00Z
```

`walkforward` prints the headline number: **lift** = the mean forward
edge of the wallets we selected, minus the same for the whole universe.
A non-positive lift means selection adds nothing over trading everyone,
and per the plan that is a **stop** — replan before investing in the
chain indexer or the execution stack.

### What the scoring layer refuses to do

These are deliberate, and each is enforced by a test:

- **Never treats hit rate as skill.** Buying a 0.90 favorite and winning
  is not edge. The primary metric is `payoff − entry price − fees`.
- **Never scores an episode before its market settles**, even one the
  wallet traded out of months earlier — its payoff was not knowable, so
  including it would import a future outcome into a past score.
- **Never bootstraps below 3 event clusters.** One cluster resamples to
  itself, giving a zero-width interval that reads as infinite certainty.
  Too few blocks returns *no* interval, which fails closed all the way
  to "cannot be Tier A".
- **Never imputes a missing settlement.** Unresolved outcomes are
  dropped from scoring, not filled with 0.5 or a last price.
- **Never mints Tier A without an out-of-sample window.** Tier A is the
  only tier the executor may act on.

## Contracts

Every event/market/outcome is validated against
`packages/contracts` (the `nbe_theta_contracts` Pydantic models) before
it is written — a malformed row is logged and skipped, never persisted.
