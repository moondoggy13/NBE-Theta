/**
 * Deterministic candle/tick replay as a Feed implementation.
 * Used by unit tests + offline simulation.
 */
import type { Feed, FeedEvent } from "./types";
import type { Candle, Tick } from "../signals/types";

export function createReplayFeed(events: Array<Candle | Tick>, interval = "1m"): Feed {
  const handlers: Array<(e: FeedEvent) => void> = [];
  let stopped = false;

  return {
    name: "replay",
    async connect() {
      stopped = false;
      for (const h of handlers) h({ kind: "open" });
      for (const ev of events) {
        if (stopped) break;
        if ("price" in ev) {
          for (const h of handlers) h({ kind: "tick", tick: ev });
        } else {
          for (const h of handlers) h({ kind: "candle", candle: ev, interval });
        }
      }
      for (const h of handlers) h({ kind: "close" });
    },
    async close() {
      stopped = true;
    },
    on(handler) {
      handlers.push(handler);
    },
  };
}
