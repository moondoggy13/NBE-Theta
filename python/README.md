# Python sidecar (offline only)

Backtesting, parameter sweeps, research notebooks.

```bash
# from python/
uv sync
uv run backtest fetch --symbol BTC-USD --interval 1m --from 2024-01-01 --to 2024-12-31 --out ../data/btc-1m-2024.ndjson
uv run backtest run --strategy mean-reversion-bb --data ../data/btc-1m-2024.ndjson --save
uv run backtest sweep --strategy mean-reversion-bb --data ../data/btc-1m-2024.ndjson --config sweeps/bb.yaml
```

`--save` writes a row to `backtest_runs` in Supabase when
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set.

Not invoked by the live worker. Purely offline.
