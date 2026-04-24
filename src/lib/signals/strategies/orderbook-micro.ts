import { imbalance, microPrice, midPrice } from "../microstructure";
import type { Strategy, StrategyContext, StrategySignal } from "../types";

const DEFAULTS = {
  levels: 5,
  imbalanceThreshold: 0.35,
  microDeviationBps: 2, // basis points
};

/**
 * Top-of-book microprice + imbalance.
 *
 * **STUB** — interface-complete, returns null in v1. Activates once we have
 * an L2 feed subscribed and per-tick latency budget accepts book processing.
 */
export function orderbookMicro(overrides: Partial<typeof DEFAULTS> = {}): Strategy {
  const params = { ...DEFAULTS, ...overrides };
  return {
    id: "orderbook-micro",
    params,
    warmupBars: 0,
    onCandle(): StrategySignal | null {
      return null;
    },
    onBook(ctx: StrategyContext): StrategySignal | null {
      if (!ctx.book) return null;
      // compute but don't act
      const mp = microPrice(ctx.book);
      const mid = midPrice(ctx.book);
      const ib = imbalance(ctx.book, params.levels);
      if (!Number.isFinite(mp) || !Number.isFinite(mid)) return null;
      void mp;
      void mid;
      void ib;
      return null;
    },
  };
}
