/**
 * Public (unauthenticated) Coinbase Exchange REST helpers.
 * Used for historical candle ingestion during backtesting; live trading
 * goes through the authenticated Advanced Trade API in src/lib/broker.
 */
import type { Candle } from "../signals/types";
import { INTERVAL_SECONDS, type Interval } from "./types";

const BASE = "https://api.exchange.coinbase.com";
const MAX_CANDLES_PER_REQUEST = 300;

interface RawCandle {
  // [timestamp(s), low, high, open, close, volume]
  0: number; 1: number; 2: number; 3: number; 4: number; 5: number;
}

export async function fetchCandles(
  symbol: string,
  interval: Interval,
  fromSec: number,
  toSec: number,
): Promise<Candle[]> {
  const granularity = INTERVAL_SECONDS[interval];
  const windowSec = granularity * MAX_CANDLES_PER_REQUEST;
  const out: Candle[] = [];
  let cursor = fromSec;

  while (cursor < toSec) {
    const end = Math.min(cursor + windowSec, toSec);
    const url =
      `${BASE}/products/${symbol}/candles` +
      `?start=${new Date(cursor * 1000).toISOString()}` +
      `&end=${new Date(end * 1000).toISOString()}` +
      `&granularity=${granularity}`;
    const res = await fetch(url, { headers: { "User-Agent": "nbe-theta-backtester/0.1" } });
    if (!res.ok) {
      throw new Error(`Coinbase candles ${res.status}: ${await res.text()}`);
    }
    const rows = (await res.json()) as RawCandle[];
    // Coinbase returns newest-first; reverse to chronological
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      out.push({
        ts: r[0] * 1000,
        l: r[1],
        h: r[2],
        o: r[3],
        c: r[4],
        v: r[5],
      });
    }
    cursor = end;
    // Coinbase public API: be gentle (3 req/sec shared pool, ~300ms spacing)
    await sleep(330);
  }

  // De-dup and sort (edge case on window boundaries)
  const seen = new Set<number>();
  const deduped = out.filter((c) => {
    if (seen.has(c.ts)) return false;
    seen.add(c.ts);
    return true;
  });
  deduped.sort((a, b) => a.ts - b.ts);
  return deduped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
