import type { Candle, L2Book, Tick } from "../signals/types";

export type FeedEvent =
  | { kind: "tick"; tick: Tick }
  | { kind: "candle"; candle: Candle; interval: string }
  | { kind: "book"; book: L2Book }
  | { kind: "error"; message: string }
  | { kind: "open" }
  | { kind: "close"; code?: number; reason?: string };

export interface Feed {
  readonly name: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  on(handler: (event: FeedEvent) => void): void;
}

export type Interval = "1m" | "5m" | "15m" | "1h" | "6h" | "1d";

export const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};

export const INTERVAL_MINUTES: Record<Interval, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "6h": 360,
  "1d": 1440,
};
