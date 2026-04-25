/**
 * Server-side Redis client. Lazy connect, single shared instance.
 * Returns null if REDIS_URL is unset so callers can no-op cleanly.
 */
import Redis from "ioredis";

let _client: Redis | null = null;

export function redisClient(): Redis | null {
  if (_client) return _client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  _client = new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  _client.on("error", () => {
    /* swallow — health endpoint will report state */
  });
  return _client;
}

export const HOT_KEYS = {
  lastPrice: "btc:last_price",
  lastPriceTs: "btc:last_price_ts",
  topBid: "btc:top_bid",
  topAsk: "btc:top_ask",
  equity: "btc:equity",
  tickRate: "btc:tick_rate", // ticks-per-minute rolling
} as const;
