import { describe, expect, it } from "vitest";
import {
  adx,
  atr,
  bollinger,
  donchian,
  ema,
  keltner,
  logReturn,
  macd,
  mean,
  rollingVwap,
  rsi,
  sma,
  stddev,
  sum,
  wilderEma,
  zscore,
} from "../indicators";
import type { Candle } from "../types";

const EPS = 1e-8;

function close(a: number, b: number, eps = EPS) {
  expect(Math.abs(a - b)).toBeLessThan(eps);
}

function candlesFromCloses(closes: number[], highOff = 1, lowOff = 1, vol = 100): Candle[] {
  return closes.map((c, i) => ({
    ts: i,
    o: i === 0 ? c : closes[i - 1],
    h: c + highOff,
    l: c - lowOff,
    c,
    v: vol,
  }));
}

describe("utilities", () => {
  it("sum and mean", () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });
  it("logReturn", () => {
    const lr = logReturn([100, 110, 121]);
    expect(Number.isNaN(lr[0])).toBe(true);
    close(lr[1], Math.log(110 / 100));
    close(lr[2], Math.log(121 / 110));
  });
});

describe("sma", () => {
  it("rolls correctly on linear data", () => {
    const out = sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    const expected = [NaN, NaN, NaN, NaN, 3, 4, 5, 6, 7, 8];
    for (let i = 0; i < expected.length; i++) {
      if (Number.isNaN(expected[i])) expect(Number.isNaN(out[i])).toBe(true);
      else close(out[i], expected[i]);
    }
  });
});

describe("ema", () => {
  it("matches manual recursion starting from SMA seed", () => {
    const out = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    // seed at i=4 is SMA(1..5) = 3. alpha = 2/6 = 1/3.
    const alpha = 2 / 6;
    const expected = [NaN, NaN, NaN, NaN, 3];
    for (let i = 5; i < 10; i++) {
      expected.push(alpha * (i + 1) + (1 - alpha) * expected[i - 1]);
    }
    for (let i = 0; i < 10; i++) {
      if (Number.isNaN(expected[i])) expect(Number.isNaN(out[i])).toBe(true);
      else close(out[i], expected[i]);
    }
  });
  it("on constant series equals the constant after warmup", () => {
    const out = ema([7, 7, 7, 7, 7, 7, 7, 7], 3);
    for (let i = 2; i < 8; i++) close(out[i], 7);
  });
});

describe("wilderEma", () => {
  it("on constant series equals the constant after warmup", () => {
    const out = wilderEma([5, 5, 5, 5, 5, 5, 5], 3);
    for (let i = 2; i < 7; i++) close(out[i], 5);
  });
  it("converges slower than 2/(p+1) EMA", () => {
    const values = [0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10, 10];
    const e = ema(values, 5);
    const w = wilderEma(values, 5);
    // Both should be rising after the step but Wilder slower
    expect(w[8]).toBeLessThan(e[8]);
  });
});

describe("stddev & zscore", () => {
  it("stddev of constant is zero", () => {
    const out = stddev([4, 4, 4, 4, 4], 3);
    close(out[2], 0);
    close(out[4], 0);
  });
  it("zscore equals deviation / stddev", () => {
    const vals = [1, 2, 3, 4, 5];
    const z = zscore(vals, 5);
    // mean = 3; variance = 10/5 = 2; stddev = sqrt(2); z[4] = (5-3)/sqrt(2) = sqrt(2)
    close(z[4], Math.SQRT2);
  });
});

describe("bollinger", () => {
  it("upper and lower are symmetric around the middle", () => {
    const vals = [10, 12, 14, 12, 10, 12, 14, 12, 10, 12, 14, 12, 10, 12, 14, 12, 10, 12, 14, 12];
    const bb = bollinger(vals, 5, 2);
    for (let i = 4; i < vals.length; i++) {
      close(bb.upper[i] - bb.middle[i], bb.middle[i] - bb.lower[i]);
    }
  });
});

describe("atr", () => {
  it("equals the average true range on constant-range candles", () => {
    const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      ts: i, o: 100, h: 102, l: 98, c: 100, v: 1,
    }));
    const a = atr(candles, 14);
    // TR = 4 for all bars after first; Wilder EMA of 4 is 4.
    close(a[13], 4);
    close(a[19], 4);
  });
});

describe("rsi", () => {
  it("is 100 on a strictly ascending series (no losses)", () => {
    const vals = Array.from({ length: 20 }, (_, i) => 100 + i);
    const r = rsi(vals, 14);
    expect(r[14]).toBe(100);
    expect(r[19]).toBe(100);
  });
  it("is bounded [0, 100]", () => {
    const vals = Array.from({ length: 40 }, () => Math.random() * 100);
    const r = rsi(vals, 14);
    for (const v of r) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("macd", () => {
  it("emits valid series once signal warmup completes", () => {
    const vals = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const m = macd(vals, 12, 26, 9);
    const last = vals.length - 1;
    expect(Number.isFinite(m.macd[last])).toBe(true);
    expect(Number.isFinite(m.signal[last])).toBe(true);
    close(m.hist[last], m.macd[last] - m.signal[last]);
  });
});

describe("adx", () => {
  it("produces finite values for trending data after warmup", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const candles = candlesFromCloses(closes);
    const a = adx(candles, 14);
    const last = candles.length - 1;
    expect(Number.isFinite(a.adx[last])).toBe(true);
    expect(Number.isFinite(a.plusDi[last])).toBe(true);
    expect(a.plusDi[last]).toBeGreaterThan(a.minusDi[last]);
  });
});

describe("rollingVwap", () => {
  it("equals mean price on uniform-volume candles", () => {
    const candles = candlesFromCloses([100, 102, 104, 106, 108], 0, 0, 1);
    const v = rollingVwap(candles, 5);
    const last = 4;
    close(v[last], (100 + 102 + 104 + 106 + 108) / 5);
  });
});

describe("donchian", () => {
  it("tracks rolling extremes", () => {
    const candles = candlesFromCloses([10, 12, 11, 14, 13, 16, 15], 0, 0);
    const d = donchian(candles, 4);
    close(d.upper[3], 14);
    close(d.lower[3], 10);
    close(d.middle[3], 12);
  });
});

describe("keltner", () => {
  it("is symmetric around EMA when ATR is constant", () => {
    const candles = candlesFromCloses(Array.from({ length: 30 }, () => 100), 2, 2, 1);
    const k = keltner(candles, 10, 2);
    const last = 29;
    close(k.upper[last] - k.middle[last], k.middle[last] - k.lower[last]);
  });
});
