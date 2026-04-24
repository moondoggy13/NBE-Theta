import { describe, expect, it } from "vitest";
import { runBacktest } from "../engine";
import { meanReversionBB } from "../../signals/strategies/mean-reversion-bb";
import { momentumEMA } from "../../signals/strategies/momentum-ema";
import type { Candle } from "../../signals/types";

function candles(closes: number[], highOff = 0.5, lowOff = 0.5): Candle[] {
  return closes.map((c, i) => ({
    ts: i * 60_000,
    o: i === 0 ? c : closes[i - 1],
    h: c + highOff,
    l: c - lowOff,
    c,
    v: 100,
  }));
}

describe("runBacktest", () => {
  it("runs without open positions when the signal never fires", () => {
    const flat = Array.from({ length: 30 }, () => 100);
    const result = runBacktest({
      candles: candles(flat),
      strategies: [meanReversionBB()],
      ensemble: { weights: { "mean-reversion-bb": 1 } },
      startEquity: 10_000,
    });
    expect(result.trades.length).toBe(0);
    expect(result.metrics.finalEquity).toBeCloseTo(10_000, 6);
  });

  it("executes at least one trade on a strong reversion setup", () => {
    // stable around 100 for warmup, then deep plunge & recovery creates a
    // long entry and subsequent flat/target exit
    const closes = [
      99, 101, 99, 101, 99, 101, 99, 101, 99, 101,
      99, 101, 99, 101, 99, 101, 99, 101, 99, 101,
      99, 101, 99, 101, 99, 101, 99, 101, 99, 101,
      92, 94, 96, 98, 100, 101, 100, 101, 100,
    ];
    const result = runBacktest({
      candles: candles(closes, 1, 1),
      strategies: [meanReversionBB()],
      ensemble: { weights: { "mean-reversion-bb": 1 } },
      startEquity: 10_000,
      riskPerTrade: 0.02,
    });
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("ensemble with disabled strategies does not crash", () => {
    const flat = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 5));
    const result = runBacktest({
      candles: candles(flat),
      strategies: [meanReversionBB(), momentumEMA()],
      ensemble: { weights: { "mean-reversion-bb": 1, "momentum-ema": 1 } },
      startEquity: 10_000,
    });
    expect(result.metrics.finalEquity).toBeGreaterThan(0);
    expect(result.equity.length).toBe(flat.length);
  });
});
