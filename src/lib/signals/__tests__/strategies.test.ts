import { describe, expect, it } from "vitest";
import { RingBuffer, makeIndicatorCache } from "../ring-buffer";
import { meanReversionBB } from "../strategies/mean-reversion-bb";
import { momentumEMA } from "../strategies/momentum-ema";
import type { Candle, StrategyContext } from "../types";

function makeContext(candles: Candle[], params: Record<string, number> = {}): StrategyContext {
  const buf = new RingBuffer<Candle>(Math.max(candles.length, 1));
  for (const c of candles) buf.push(c);
  return {
    now: candles.at(-1)?.ts ?? 0,
    symbol: "BTC-USD",
    candles: buf,
    ticks: new RingBuffer(1),
    indicators: makeIndicatorCache(),
    params,
  };
}

function candlesFromCloses(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    ts: i * 60_000,
    o: i === 0 ? c : closes[i - 1],
    h: c + 1,
    l: c - 1,
    c,
    v: 100,
  }));
}

describe("meanReversionBB", () => {
  // 30 oscillating candles around 100 (stddev ~1) so bollinger has defined sigma
  const oscillation = (end: number) => {
    const base = Array.from({ length: 29 }, (_, i) => (i % 2 === 0 ? 99 : 101));
    return [...base, end];
  };

  it("emits long when price is far below the band", () => {
    const sig = meanReversionBB().onCandle(makeContext(candlesFromCloses(oscillation(80))));
    expect(sig?.side).toBe("long");
    expect(sig!.features.zscore).toBeLessThan(-2);
    expect(sig!.entryHint!.stop).toBeLessThan(80);
  });

  it("emits short when price is far above the band", () => {
    const sig = meanReversionBB().onCandle(makeContext(candlesFromCloses(oscillation(120))));
    expect(sig?.side).toBe("short");
    expect(sig!.features.zscore).toBeGreaterThan(2);
  });

  it("emits flat once price returns to the mean", () => {
    const sig = meanReversionBB().onCandle(makeContext(candlesFromCloses(oscillation(100))));
    expect(sig?.side).toBe("flat");
  });

  it("returns null during warmup", () => {
    const closes = Array.from({ length: 10 }, () => 100);
    expect(meanReversionBB().onCandle(makeContext(candlesFromCloses(closes)))).toBeNull();
  });
});

describe("momentumEMA", () => {
  it("emits long on sustained uptrend", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.8);
    const strat = momentumEMA();
    const sig = strat.onCandle(makeContext(candlesFromCloses(closes)));
    expect(sig?.side).toBe("long");
    expect(sig!.features.adx).toBeGreaterThan(20);
    expect(sig!.entryHint!.stop).toBeLessThan(sig!.entryHint!.price);
    expect(sig!.entryHint!.target).toBeGreaterThan(sig!.entryHint!.price);
  });

  it("emits short on sustained downtrend", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 200 - i * 0.8);
    const strat = momentumEMA();
    const sig = strat.onCandle(makeContext(candlesFromCloses(closes)));
    expect(sig?.side).toBe("short");
  });

  it("emits flat when ADX is weak (chop)", () => {
    // oscillation with small amplitude → low ADX
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 2) * 0.2);
    const strat = momentumEMA();
    const sig = strat.onCandle(makeContext(candlesFromCloses(closes)));
    expect(sig?.side).toBe("flat");
  });
});
