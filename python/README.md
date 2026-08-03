# nbe_theta (Python worker)

The Polymarket **Intelligence** and **Signal** layers. One package,
multiple commands, one shared `common/` module (config, logging, db,
http). See `docs/adr/0001-polymarket-pivot.md`.

## Commands

| Command | Status | What it does |
|---|---|---|
| `theta-registry` | **PR 3 (this)** | Sweep the Gamma API → normalize markets/events/outcomes → version resolution rules → archive raw pages. |
| `theta-wallet-backfill` | later | Data API candidate + history ingestion. |
| `theta-score-wallets` | later | Wallet skill scoring. |
| `theta-signal-generator` | later | Emit typed signal envelopes. |
| … | later | ledger, graph, backtest, chain-enricher. |

## Layout

```
nbe_theta/
├── common/        config, logging (JSON), db (psycopg), http (fetch seam)
└── ingest/
    ├── gamma.py     Gamma client + defensive parsing
    ├── store.py     Store ABC + PostgresStore + InMemoryStore
    ├── archive.py   raw-response archive (FS now, R2/S3 later)
    ├── registry.py  the ingestor: sweep → validate → upsert → version
    └── cli.py       theta-registry entrypoint
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

## Contracts

Every event/market/outcome is validated against
`packages/contracts` (the `nbe_theta_contracts` Pydantic models) before
it is written — a malformed row is logged and skipped, never persisted.
