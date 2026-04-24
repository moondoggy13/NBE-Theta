/**
 * Pure-math indicator kernels.
 *
 * All series-returning functions emit an array the same length as the input,
 * with `NaN` filling the warmup prefix so that index i always maps to input i.
 * Callers reading live should check `Number.isNaN(last)` before using.
 *
 * Smoothing conventions:
 *   - EMA seeds with the SMA of the first `period` values, then recurses.
 *   - ATR, RSI, ADX use Wilder's smoothing (period acts as 2p-1 EMA).
 */
import type { Candle } from "./types";

// ─── utilities ────────────────────────────────────────────────────────────

export function sum(values: ArrayLike<number>, from = 0, to = values.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += values[i];
  return s;
}

export function mean(values: ArrayLike<number>, from = 0, to = values.length): number {
  return sum(values, from, to) / (to - from);
}

/** Log return series, same length as input. Index 0 is NaN. */
export function logReturn(values: ArrayLike<number>): number[] {
  const out = new Array<number>(values.length);
  out[0] = NaN;
  for (let i = 1; i < values.length; i++) out[i] = Math.log(values[i] / values[i - 1]);
  return out;
}

// ─── moving averages ──────────────────────────────────────────────────────

export function sma(values: ArrayLike<number>, period: number): number[] {
  if (period <= 0) throw new Error("period must be > 0");
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;
  let rolling = 0;
  for (let i = 0; i < period; i++) rolling += values[i];
  out[period - 1] = rolling / period;
  for (let i = period; i < n; i++) {
    rolling += values[i] - values[i - period];
    out[i] = rolling / period;
  }
  return out;
}

export function ema(values: ArrayLike<number>, period: number): number[] {
  if (period <= 0) throw new Error("period must be > 0");
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < n; i++) {
    out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

/** Wilder's EMA: α = 1/period (equivalent to an EMA of period 2p-1). */
export function wilderEma(values: ArrayLike<number>, period: number): number[] {
  if (period <= 0) throw new Error("period must be > 0");
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

// ─── dispersion ───────────────────────────────────────────────────────────

/** Rolling population standard deviation (denominator = period). */
export function stddev(values: ArrayLike<number>, period: number): number[] {
  if (period <= 0) throw new Error("period must be > 0");
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;
  const means = sma(values, period);
  for (let i = period - 1; i < n; i++) {
    const m = means[i];
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - m;
      sq += d * d;
    }
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

export function zscore(values: ArrayLike<number>, period: number): number[] {
  const n = values.length;
  const m = sma(values, period);
  const s = stddev(values, period);
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(m[i]) && s[i] > 0) out[i] = (values[i] - m[i]) / s[i];
  }
  return out;
}

// ─── bands & envelopes ────────────────────────────────────────────────────

export interface Bands {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function bollinger(values: ArrayLike<number>, period = 20, k = 2): Bands {
  const n = values.length;
  const middle = sma(values, period);
  const sd = stddev(values, period);
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(middle[i])) {
      upper[i] = middle[i] + k * sd[i];
      lower[i] = middle[i] - k * sd[i];
    }
  }
  return { upper, middle, lower };
}

export function keltner(candles: readonly Candle[], period = 20, mult = 2): Bands {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const middle = ema(closes, period);
  const a = atr(candles, period);
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(middle[i]) && !Number.isNaN(a[i])) {
      upper[i] = middle[i] + mult * a[i];
      lower[i] = middle[i] - mult * a[i];
    }
  }
  return { upper, middle, lower };
}

export function donchian(candles: readonly Candle[], period = 20): Bands {
  const n = candles.length;
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  const middle = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].h > hi) hi = candles[j].h;
      if (candles[j].l < lo) lo = candles[j].l;
    }
    upper[i] = hi;
    lower[i] = lo;
    middle[i] = (hi + lo) / 2;
  }
  return { upper, middle, lower };
}

// ─── ATR & Wilder-based ───────────────────────────────────────────────────

function trueRange(candles: readonly Candle[]): number[] {
  const n = candles.length;
  const tr = new Array<number>(n);
  if (n === 0) return tr;
  tr[0] = candles[0].h - candles[0].l;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }
  return tr;
}

export function atr(candles: readonly Candle[], period = 14): number[] {
  return wilderEma(trueRange(candles), period);
}

export function rsi(values: ArrayLike<number>, period = 14): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= period) return out;
  const gains = new Array<number>(n).fill(0);
  const losses = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains[i] = d;
    else losses[i] = -d;
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }
  return out;
}

export interface Macd {
  macd: number[];
  signal: number[];
  hist: number[];
}

export function macd(values: ArrayLike<number>, fast = 12, slow = 26, signalPeriod = 9): Macd {
  if (fast >= slow) throw new Error("fast must be < slow");
  const efast = ema(values, fast);
  const eslow = ema(values, slow);
  const n = values.length;
  const macdLine = new Array<number>(n).fill(NaN);
  for (let i = slow - 1; i < n; i++) macdLine[i] = efast[i] - eslow[i];

  // EMA of the MACD line, starting only once we have `signalPeriod` non-NaN values.
  const signal = new Array<number>(n).fill(NaN);
  const hist = new Array<number>(n).fill(NaN);
  const seedStart = slow - 1;
  if (n >= seedStart + signalPeriod) {
    let seed = 0;
    for (let i = seedStart; i < seedStart + signalPeriod; i++) seed += macdLine[i];
    signal[seedStart + signalPeriod - 1] = seed / signalPeriod;
    const alpha = 2 / (signalPeriod + 1);
    for (let i = seedStart + signalPeriod; i < n; i++) {
      signal[i] = alpha * macdLine[i] + (1 - alpha) * signal[i - 1];
    }
    for (let i = seedStart + signalPeriod - 1; i < n; i++) hist[i] = macdLine[i] - signal[i];
  }
  return { macd: macdLine, signal, hist };
}

// ─── VWAP ─────────────────────────────────────────────────────────────────

/** Rolling N-bar VWAP across a candle series. */
export function rollingVwap(candles: readonly Candle[], period = 20): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;
  const tp = candles.map((c) => (c.h + c.l + c.c) / 3);
  let vSum = 0;
  let pvSum = 0;
  for (let i = 0; i < period; i++) {
    vSum += candles[i].v;
    pvSum += tp[i] * candles[i].v;
  }
  out[period - 1] = vSum === 0 ? NaN : pvSum / vSum;
  for (let i = period; i < n; i++) {
    vSum += candles[i].v - candles[i - period].v;
    pvSum += tp[i] * candles[i].v - tp[i - period] * candles[i - period].v;
    out[i] = vSum === 0 ? NaN : pvSum / vSum;
  }
  return out;
}

// ─── ADX (Wilder) ─────────────────────────────────────────────────────────

export interface Adx {
  plusDi: number[];
  minusDi: number[];
  adx: number[];
}

export function adx(candles: readonly Candle[], period = 14): Adx {
  const n = candles.length;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = trueRange(candles);
  for (let i = 1; i < n; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    if (upMove > downMove && upMove > 0) plusDM[i] = upMove;
    if (downMove > upMove && downMove > 0) minusDM[i] = downMove;
  }
  const smTR = wilderEma(tr, period);
  const smPlus = wilderEma(plusDM, period);
  const smMinus = wilderEma(minusDM, period);
  const plusDi = new Array<number>(n).fill(NaN);
  const minusDi = new Array<number>(n).fill(NaN);
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(smTR[i]) && smTR[i] > 0) {
      plusDi[i] = 100 * (smPlus[i] / smTR[i]);
      minusDi[i] = 100 * (smMinus[i] / smTR[i]);
      const sum = plusDi[i] + minusDi[i];
      dx[i] = sum === 0 ? 0 : 100 * (Math.abs(plusDi[i] - minusDi[i]) / sum);
    }
  }
  const adxSeries = wilderEma(dx.map((v) => (Number.isNaN(v) ? 0 : v)), period);
  // Mask warmup
  const firstValid = period * 2 - 1;
  for (let i = 0; i < firstValid && i < n; i++) adxSeries[i] = NaN;
  return { plusDi, minusDi, adx: adxSeries };
}

// ─── convenience: extract close series ────────────────────────────────────

export function closes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.c);
}

export function highs(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.h);
}

export function lows(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.l);
}

export function volumes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.v);
}
