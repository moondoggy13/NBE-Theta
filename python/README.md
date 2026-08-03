# nbe_theta (Python worker)

The Polymarket **Intelligence** and **Signal** layers. One package,
multiple commands, one shared `common/` module (config, logging, db,
http). See `docs/adr/0001-polymarket-pivot.md`.

## Commands

| Command | Status | What it does |
|---|---|---|
| `theta-registry` | PR 3 | Sweep the Gamma API → normalize markets/events/outcomes → version resolution rules → archive raw pages. |
| `theta-wallet-backfill` | **PR 4 (this)** | `seed`: discover candidates (leaderboards, top holders) → promote by materiality. `run`: backfill Data API trade history into `venue_trades`. |
| `theta-score-wallets` | later | Wallet skill scoring. |
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
    └── archive.py      raw-response archive (FS now, R2/S3 later)
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

## Contracts

Every event/market/outcome is validated against
`packages/contracts` (the `nbe_theta_contracts` Pydantic models) before
it is written — a malformed row is logged and skipped, never persisted.
