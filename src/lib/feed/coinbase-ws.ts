/**
 * Coinbase Advanced Trade public WebSocket feed.
 *
 *   wss://advanced-trade-ws.coinbase.com
 *
 * Public channels (no JWT required): market_trades, ticker, level2, heartbeats.
 * Emits normalized FeedEvents to the attached handler.
 */
import WebSocket from "ws";
import type { Feed, FeedEvent } from "./types";
import type { L2Book, Level, Tick } from "../signals/types";

const WS_URL = "wss://advanced-trade-ws.coinbase.com";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;

export interface CoinbaseWsOptions {
  productIds: string[];
  channels?: Array<"market_trades" | "ticker" | "level2" | "heartbeats">;
  bookDepth?: number;
}

export function createCoinbaseWsFeed(opts: CoinbaseWsOptions): Feed {
  const handlers: Array<(e: FeedEvent) => void> = [];
  const channels = opts.channels ?? ["market_trades", "ticker", "heartbeats"];
  const bookDepth = opts.bookDepth ?? 10;
  const books = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();

  let ws: WebSocket | null = null;
  let backoff = RECONNECT_BASE_MS;
  let closed = false;
  let lastHeartbeat = Date.now();
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const emit = (e: FeedEvent) => {
    for (const h of handlers) h(e);
  };

  const watchHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        emit({ kind: "error", message: "heartbeat timeout; reconnecting" });
        ws?.terminate();
      }
    }, 5_000);
  };

  const connect = async () => {
    ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      backoff = RECONNECT_BASE_MS;
      lastHeartbeat = Date.now();
      watchHeartbeat();
      emit({ kind: "open" });
      for (const ch of channels) {
        ws?.send(JSON.stringify({ type: "subscribe", product_ids: opts.productIds, channel: ch }));
      }
    });
    ws.on("message", (raw) => {
      lastHeartbeat = Date.now();
      let msg: CoinbaseWsMessage;
      try {
        msg = JSON.parse(raw.toString()) as CoinbaseWsMessage;
      } catch (err) {
        emit({ kind: "error", message: `non-JSON frame: ${String(err)}` });
        return;
      }
      routeMessage(msg, books, bookDepth, emit);
    });
    ws.on("error", (err) => emit({ kind: "error", message: err.message }));
    ws.on("close", (code, reason) => {
      emit({ kind: "close", code, reason: reason.toString() });
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (!closed) {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    });
  };

  return {
    name: "coinbase-advanced-ws",
    async connect() {
      closed = false;
      await connect();
    },
    async close() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      ws?.close();
    },
    on(handler) {
      handlers.push(handler);
    },
  };
}

// ─── Message typing (minimal shapes we actually use) ──────────────────────

interface CoinbaseWsMessage {
  channel: string;
  timestamp?: string;
  events?: Array<{
    type?: string;
    product_id?: string;
    trades?: Array<{ trade_id: string; product_id: string; price: string; size: string; side: string; time: string }>;
    tickers?: Array<{ product_id: string; price: string; volume_24_h: string; best_bid?: string; best_ask?: string }>;
    updates?: Array<{ side: "bid" | "offer"; event_time: string; price_level: string; new_quantity: string }>;
  }>;
}

function routeMessage(
  msg: CoinbaseWsMessage,
  books: Map<string, { bids: Map<number, number>; asks: Map<number, number> }>,
  depth: number,
  emit: (e: FeedEvent) => void,
) {
  if (msg.channel === "heartbeats") return;
  for (const ev of msg.events ?? []) {
    if (msg.channel === "market_trades" && ev.trades) {
      for (const t of ev.trades) {
        const tick: Tick = {
          ts: Date.parse(t.time),
          price: Number(t.price),
          size: Number(t.size),
          side: t.side.toLowerCase() === "buy" ? "buy" : "sell",
        };
        emit({ kind: "tick", tick });
      }
    } else if (msg.channel === "ticker" && ev.tickers) {
      for (const t of ev.tickers) {
        // synthesize a tick from ticker (price only, size 0)
        const tick: Tick = {
          ts: Date.now(),
          price: Number(t.price),
          size: 0,
          side: "buy",
        };
        emit({ kind: "tick", tick });
      }
    } else if (msg.channel === "l2_data" && ev.updates) {
      const pid = ev.product_id!;
      let b = books.get(pid);
      if (!b) {
        b = { bids: new Map(), asks: new Map() };
        books.set(pid, b);
      }
      for (const u of ev.updates) {
        const price = Number(u.price_level);
        const qty = Number(u.new_quantity);
        const side = u.side === "bid" ? b.bids : b.asks;
        if (qty <= 0) side.delete(price);
        else side.set(price, qty);
      }
      emit({ kind: "book", book: snapshotBook(pid, b, depth) });
    }
  }
}

function snapshotBook(
  _pid: string,
  b: { bids: Map<number, number>; asks: Map<number, number> },
  depth: number,
): L2Book {
  const sortedBids = [...b.bids.entries()].sort((a, b2) => b2[0] - a[0]).slice(0, depth) as Level[];
  const sortedAsks = [...b.asks.entries()].sort((a, b2) => a[0] - b2[0]).slice(0, depth) as Level[];
  return { ts: Date.now(), bids: sortedBids, asks: sortedAsks };
}
