/**
 * Wires the Coinbase public feed into the worker's ring buffers.
 * Aggregates tick prints into 1-minute candles locally so we don't need
 * to poll REST for minute bars.
 */
import { createCoinbaseWsFeed } from "../src/lib/feed/coinbase-ws";
import type { Feed, FeedEvent } from "../src/lib/feed/types";
import type { Candle, Tick } from "../src/lib/signals/types";
import { RingBuffer } from "../src/lib/signals/ring-buffer";
import type { Logger } from "./lib/logger";

export interface FeedState {
  ticks: RingBuffer<Tick>;
  candles: RingBuffer<Candle>;
  lastPrice: number;
}

export interface FeedOptions {
  symbol: string;
  bufferTicks: number;
  bufferCandles: number;
  logger: Logger;
  onCandleClose: (candle: Candle, state: FeedState) => void;
  onTick: (tick: Tick, state: FeedState) => void;
}

export function startFeed(opts: FeedOptions): { feed: Feed; state: FeedState } {
  const state: FeedState = {
    ticks: new RingBuffer<Tick>(opts.bufferTicks),
    candles: new RingBuffer<Candle>(opts.bufferCandles),
    lastPrice: NaN,
  };

  let currentBarStart = 0;
  let currentBar: Candle | null = null;

  const handleTick = (tick: Tick) => {
    state.lastPrice = tick.price;
    state.ticks.push(tick);

    const barStart = Math.floor(tick.ts / 60_000) * 60_000;
    if (!currentBar || barStart !== currentBarStart) {
      if (currentBar) {
        state.candles.push(currentBar);
        opts.onCandleClose(currentBar, state);
      }
      currentBarStart = barStart;
      currentBar = { ts: barStart, o: tick.price, h: tick.price, l: tick.price, c: tick.price, v: tick.size };
    } else {
      if (tick.price > currentBar.h) currentBar.h = tick.price;
      if (tick.price < currentBar.l) currentBar.l = tick.price;
      currentBar.c = tick.price;
      currentBar.v += tick.size;
    }
    opts.onTick(tick, state);
  };

  const feed = createCoinbaseWsFeed({
    productIds: [opts.symbol],
    channels: ["market_trades", "heartbeats"],
  });
  feed.on((event: FeedEvent) => {
    if (event.kind === "open") opts.logger.info({ feed: feed.name }, "feed open");
    else if (event.kind === "close") opts.logger.warn({ code: event.code, reason: event.reason }, "feed close");
    else if (event.kind === "error") opts.logger.error({ message: event.message }, "feed error");
    else if (event.kind === "tick") handleTick(event.tick);
  });

  return { feed, state };
}

/**
 * Bootstrap: fetch the last N 1m candles from Coinbase REST so the strategy
 * ring-buffer is pre-warmed when the WS connects.
 */
export async function bootstrapCandles(symbol: string, bars: number): Promise<Candle[]> {
  const { fetchCandles } = await import("../src/lib/feed/coinbase-public");
  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - bars * 60;
  return fetchCandles(symbol, "1m", fromSec, toSec);
}
