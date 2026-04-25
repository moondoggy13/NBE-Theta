/**
 * Live BTC price endpoint.
 *   1. Read from Redis hot key (worker pushes every tick) — sub-millisecond.
 *   2. If Redis is empty/unavailable, fall back to Coinbase public REST.
 *   3. Also returns 24h stats (open, high, low, volume, change) via
 *      Coinbase public stats endpoint, cached in-memory for 30s.
 */
import { NextResponse } from "next/server";
import { HOT_KEYS, redisClient } from "@/lib/redis/client";

interface Stats24h {
  open: number;
  high: number;
  low: number;
  last: number;
  volume: number;
  changePct: number;
  fetchedAt: number;
}

let statsCache: Stats24h | null = null;

async function fetch24h(): Promise<Stats24h | null> {
  const now = Date.now();
  if (statsCache && now - statsCache.fetchedAt < 30_000) return statsCache;
  try {
    const res = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/stats", {
      headers: { "User-Agent": "nbe-theta/0.1" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return statsCache;
    const j = (await res.json()) as Record<string, string>;
    const open = Number(j.open);
    const last = Number(j.last);
    statsCache = {
      open,
      high: Number(j.high),
      low: Number(j.low),
      last,
      volume: Number(j.volume),
      changePct: open > 0 ? ((last - open) / open) * 100 : 0,
      fetchedAt: now,
    };
    return statsCache;
  } catch {
    return statsCache;
  }
}

export async function GET() {
  const redis = redisClient();
  let price: number | null = null;
  let priceTs: number | null = null;
  let tickRate: number | null = null;
  if (redis) {
    try {
      const [p, t, r] = await redis.mget(
        HOT_KEYS.lastPrice,
        HOT_KEYS.lastPriceTs,
        HOT_KEYS.tickRate,
      );
      if (p) price = Number(p);
      if (t) priceTs = Number(t);
      if (r) tickRate = Number(r);
    } catch { /* fall through */ }
  }

  const stats = await fetch24h();
  if (price == null && stats) {
    price = stats.last;
    priceTs = stats.fetchedAt;
  }

  return NextResponse.json({
    price,
    priceTs,
    tickRate,
    stats,
    source: redis && price ? "redis" : stats ? "coinbase-stats" : "unavailable",
  });
}
