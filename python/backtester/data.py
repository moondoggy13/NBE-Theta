"""Historical candle ingestion — reads NDJSON exported by
`pnpm fetch-history` or pulls fresh from Coinbase public REST."""
from __future__ import annotations

import json
from pathlib import Path
from datetime import datetime, timezone

import httpx
import pandas as pd

COINBASE_BASE = "https://api.exchange.coinbase.com"
INTERVAL_SECS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400}


def load_ndjson(path: str | Path) -> pd.DataFrame:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return pd.DataFrame(rows)


def fetch_candles(symbol: str, interval: str, from_iso: str, to_iso: str) -> pd.DataFrame:
    granularity = INTERVAL_SECS[interval]
    window = granularity * 300
    from_s = int(datetime.fromisoformat(from_iso).replace(tzinfo=timezone.utc).timestamp())
    to_s = int(datetime.fromisoformat(to_iso).replace(tzinfo=timezone.utc).timestamp())

    candles: list[dict] = []
    cursor = from_s
    with httpx.Client(timeout=30) as client:
        while cursor < to_s:
            end = min(cursor + window, to_s)
            r = client.get(
                f"{COINBASE_BASE}/products/{symbol}/candles",
                params={
                    "start": datetime.fromtimestamp(cursor, timezone.utc).isoformat(),
                    "end": datetime.fromtimestamp(end, timezone.utc).isoformat(),
                    "granularity": granularity,
                },
            )
            r.raise_for_status()
            rows = r.json()
            for row in rows:
                candles.append({"ts": row[0] * 1000, "l": row[1], "h": row[2], "o": row[3], "c": row[4], "v": row[5]})
            cursor = end
    df = pd.DataFrame(candles).drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
    return df
