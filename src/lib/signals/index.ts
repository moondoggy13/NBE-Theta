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
export { volBreakoutKeltner } from "./strategies/vol-breakout-keltner";
export { orderbookMicro } from "./strategies/orderbook-micro";
export { tsMomEnsemble } from "./strategies/ts-mom-ensemble";
export { aggregate } from "./ensemble";
export { master, signalToZ, flatWeightsFromMap, uniformPosterior } from "./master";
export type { EnsembleWeights, EnsembleOptions } from "./ensemble";
export type { MasterDecision, MasterOptions, MasterWeights } from "./master";

import { meanReversionBB } from "./strategies/mean-reversion-bb";
import { momentumEMA } from "./strategies/momentum-ema";
import { tsMomEnsemble } from "./strategies/ts-mom-ensemble";
import { volBreakoutATR } from "./strategies/vol-breakout-atr";
import { volBreakoutKeltner } from "./strategies/vol-breakout-keltner";
import { orderbookMicro } from "./strategies/orderbook-micro";

/**
 * Registry of strategies the engine knows how to build. `enabled` flags
 * which ones participate in the active sleeve.
 *
 * Phase-1 update:
 *   - `ts-mom-ensemble` (multi-LB momentum) replaces single-TF momentum-ema
 *     as the trend sleeve.
 *   - `vol-breakout-keltner` replaces the v1 stub vol-breakout-atr as the
 *     volatility breakout sleeve.
 *   - `momentum-ema` and `vol-breakout-atr` remain in the registry but
 *     `enabled: false` so historical paper data + tests stay comparable.
 */
export const strategyRegistry = {
  "mean-reversion-bb":    { build: meanReversionBB,    enabled: true  },
  "ts-mom-ensemble":      { build: tsMomEnsemble,      enabled: true  },
  "vol-breakout-keltner": { build: volBreakoutKeltner, enabled: true  },
  "momentum-ema":         { build: momentumEMA,        enabled: false },
  "vol-breakout-atr":     { build: volBreakoutATR,     enabled: false },
  "orderbook-micro":      { build: orderbookMicro,     enabled: false },
} as const;

export type StrategyId = keyof typeof strategyRegistry;
