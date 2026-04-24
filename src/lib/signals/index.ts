export type {
  Candle,
  Tick,
  L2Book,
  Level,
  Side,
  Strategy,
  StrategyContext,
  StrategySignal,
  ReadonlyRingBuffer,
  IndicatorCache,
  EnsembleDecision,
} from "./types";

export { RingBuffer, makeIndicatorCache } from "./ring-buffer";
export * as indicators from "./indicators";
export * as microstructure from "./microstructure";
export { meanReversionBB } from "./strategies/mean-reversion-bb";
export { momentumEMA } from "./strategies/momentum-ema";
export { volBreakoutATR } from "./strategies/vol-breakout-atr";
export { orderbookMicro } from "./strategies/orderbook-micro";
export { aggregate } from "./ensemble";
export type { EnsembleWeights, EnsembleOptions } from "./ensemble";

import { meanReversionBB } from "./strategies/mean-reversion-bb";
import { momentumEMA } from "./strategies/momentum-ema";
import { volBreakoutATR } from "./strategies/vol-breakout-atr";
import { orderbookMicro } from "./strategies/orderbook-micro";

/**
 * Registry of strategies the engine knows how to build. `enabled` flags
 * which ones participate in the live ensemble; stubs stay false in v1.
 */
export const strategyRegistry = {
  "mean-reversion-bb": { build: meanReversionBB, enabled: true },
  "momentum-ema":      { build: momentumEMA,      enabled: true },
  "vol-breakout-atr":  { build: volBreakoutATR,   enabled: false },
  "orderbook-micro":   { build: orderbookMicro,   enabled: false },
} as const;

export type StrategyId = keyof typeof strategyRegistry;
