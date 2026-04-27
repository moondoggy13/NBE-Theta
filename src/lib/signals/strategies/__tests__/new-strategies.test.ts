import { describe, expect, it } from "vitest";
import { RingBuffer, makeIndicatorCache } from "../../ring-buffer";
import { tsMomEnsemble } from "../ts-mom-ensemble";
import { volBreakoutKeltner } from "../vol-breakout-keltner";
import type { Candle, StrategyContext } from "../../types";

function makeContext(candles: Candle[]): StrategyContext {
  const buf = new RingBuffer<Candle>(Math.max(candles.length, 1));
  for (const c of candles) buf.push(c);
  return {
    now: candles.at(-1)?.ts ?? 0,
    symbol: "BTC-USD",
    candles: buf,
    ticks: new RingBuffer(1),
    indicators: makeIndicatorCache(),
    params: {},
  };
}

function candlesFromCloses(closes: number[], hOff = 1, lOff = 1, vol = 100): Candle[] {
  return closes.map((c, i) => ({
    ts: i * 60_000,
    o: i === 0 ? c : closes[i - 1],
    h: c + hOff,
    l: c - lOff,
    c,
    v: vol,
  }));
}

describe("tsMomEnsemble", () => {
  it("emits long on sustained uptrend", () => {
    const closes = Array.from({ length: 150 }, (_, i) => 100 + i * 0.5);
    const sig = tsMomEnsemble().onCandle(makeContext(candlesFromCloses(closes)));
    expect(sig?.side).toBe("long");
    expect(sig!.score).toBeGreaterThan(0.1);
  });
  it("emits short on sustained downtrend", () => {
    const closes = Array.from({ length: 150 }, (_, i) => 200 - i * 0.5);
    const sig = tsMomEnsemble().onCandle(makeContext(candlesFromCloses(closes)));
    expect(sig?.side).toBe("short");
    expect(sig!.score).toBeLessThan(-0.1);
  });
  it("emits flat on a flat price series (no drift)", () => {
    const closes = Array.from({ length: 150 }, () => 100);
    const sig = tsMomEnsemble().onCandle(makeContext(candlesFromCloses(closes)));
    // Either null (degenerate σ=0) or flat is acceptable; the key invariant
    // is "not directional".
    expect(sig?.side ?? "flat").toBe("flat");
  });
  it("returns null during warmup (< 125 bars default)", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(tsMomEnsemble().onCandle(makeContext(candlesFromCloses(closes)))).toBeNull();
  });
});

describe("volBreakoutKeltner", () => {
  it("requires volume confirmation — quiet breakout returns flat", () => {
    // Steady growth above Keltner upper but no volume spike.
    const closes = Array.from({ length: 30 }, (_, i) => (i < 25 ? 100 : 110 + i));
    const candles = candlesFromCloses(closes, 1, 1, 100);
    const sig = volBreakoutKeltner().onCandle(makeContext(candles));
    expect(sig?.side).toBe("flat");
  });
  it("emits long on a high-volume breakout above the upper band", () => {
    // Build a flat history then a clear breakout bar with 3x volume.
    const closes: number[] = Array.from({ length: 30 }, (_, i) =>
      i < 28 ? 100 : 100 + (i - 27) * 3,
    );
    const candles = candlesFromCloses(closes, 0.5, 0.5).map((c, i) => ({
      ...c,
      v: i === closes.length - 1 ? 400 : 100,
    }));
    const sig = volBreakoutKeltner().onCandle(makeContext(candles));
    expect(sig?.side).toBe("long");
    expect(sig!.entryHint).toBeTruthy();
    expect(sig!.entryHint!.stop).toBeLessThan(sig!.entryHint!.price);
  });
  it("emits short on high-volume breakdown below the lower band", () => {
    const closes: number[] = Array.from({ length: 30 }, (_, i) =>
      i < 28 ? 100 : 100 - (i - 27) * 3,
    );
    const candles = candlesFromCloses(closes, 0.5, 0.5).map((c, i) => ({
      ...c,
      v: i === closes.length - 1 ? 400 : 100,
    }));
    const sig = volBreakoutKeltner().onCandle(makeContext(candles));
    expect(sig?.side).toBe("short");
  });
});
