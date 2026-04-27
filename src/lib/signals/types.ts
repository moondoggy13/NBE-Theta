export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Tick {
  ts: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}

export type Level = [price: number, size: number];

export interface L2Book {
  ts: number;
  bids: Level[];
  asks: Level[];
}

export type Side = "long" | "short" | "flat";

export interface StrategySignal {
  strategyId: string;
  ts: number;
  side: Side;
  score: number;
  confidence: number;
  features: Record<string, number>;
  entryHint?: { price: number; stop: number; target: number };
}

export interface ReadonlyRingBuffer<T> {
  readonly size: number;
  readonly capacity: number;
  at(i: number): T | undefined;
  last(n?: number): T[];
  toArray(): T[];
  [Symbol.iterator](): IterableIterator<T>;
}

export interface IndicatorCache {
  get<T>(key: string, compute: () => T): T;
  clear(): void;
}

export interface StrategyContext {
  now: number;
  symbol: string;
  candles: ReadonlyRingBuffer<Candle>;
  ticks: ReadonlyRingBuffer<Tick>;
  book?: L2Book;
  indicators: IndicatorCache;
  params: Record<string, number>;
}

export interface Strategy {
  id: string;
  params: Record<string, number>;
  warmupBars: number;
  onCandle(ctx: StrategyContext): StrategySignal | null;
  onTick?(ctx: StrategyContext): StrategySignal | null;
  onBook?(ctx: StrategyContext): StrategySignal | null;
}

export interface EnsembleDecision {
  ts: number;
  side: Side;
  score: number;
  confidence: number;
  contributing: Array<{
    strategyId: string;
    side: Side;
    score: number;
    confidence: number;
    weight: number;
    entryHint?: StrategySignal["entryHint"];
  }>;
}
