"""Numpy mirrors of src/lib/signals/indicators.ts.

Warm-up values are NaN. EMA seeds with the SMA of the first `period` values.
ATR, RSI, ADX use Wilder's smoothing (alpha = 1 / period).
"""
from __future__ import annotations

import numpy as np


def sma(values: np.ndarray, period: int) -> np.ndarray:
    n = len(values)
    out = np.full(n, np.nan)
    if n < period:
        return out
    csum = np.cumsum(values)
    out[period - 1] = csum[period - 1] / period
    out[period:] = (csum[period:] - csum[: n - period]) / period
    return out


def ema(values: np.ndarray, period: int) -> np.ndarray:
    n = len(values)
    out = np.full(n, np.nan)
    if n < period:
        return out
    alpha = 2.0 / (period + 1)
    out[period - 1] = values[:period].mean()
    for i in range(period, n):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def wilder_ema(values: np.ndarray, period: int) -> np.ndarray:
    n = len(values)
    out = np.full(n, np.nan)
    if n < period:
        return out
    out[period - 1] = values[:period].mean()
    for i in range(period, n):
        out[i] = (out[i - 1] * (period - 1) + values[i]) / period
    return out


def stddev(values: np.ndarray, period: int) -> np.ndarray:
    """Rolling population standard deviation (denominator = period)."""
    n = len(values)
    out = np.full(n, np.nan)
    if n < period:
        return out
    means = sma(values, period)
    for i in range(period - 1, n):
        w = values[i - period + 1 : i + 1]
        out[i] = np.sqrt(((w - means[i]) ** 2).sum() / period)
    return out


def zscore(values: np.ndarray, period: int) -> np.ndarray:
    m = sma(values, period)
    s = stddev(values, period)
    with np.errstate(divide="ignore", invalid="ignore"):
        z = np.where(s > 0, (values - m) / s, np.nan)
    return z


def bollinger(values: np.ndarray, period: int = 20, k: float = 2.0):
    middle = sma(values, period)
    s = stddev(values, period)
    return {"upper": middle + k * s, "middle": middle, "lower": middle - k * s}


def true_range(h: np.ndarray, l: np.ndarray, c: np.ndarray) -> np.ndarray:
    n = len(c)
    tr = np.empty(n)
    tr[0] = h[0] - l[0]
    if n > 1:
        pc = c[:-1]
        tr[1:] = np.maximum.reduce([h[1:] - l[1:], np.abs(h[1:] - pc), np.abs(l[1:] - pc)])
    return tr


def atr(h: np.ndarray, l: np.ndarray, c: np.ndarray, period: int = 14) -> np.ndarray:
    return wilder_ema(true_range(h, l, c), period)


def rsi(values: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(values)
    out = np.full(n, np.nan)
    if n <= period:
        return out
    diff = np.diff(values, prepend=values[0])
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    avg_g = gains[1 : period + 1].mean()
    avg_l = losses[1 : period + 1].mean()
    rs = np.inf if avg_l == 0 else avg_g / avg_l
    out[period] = 100 - 100 / (1 + rs)
    for i in range(period + 1, n):
        avg_g = (avg_g * (period - 1) + gains[i]) / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
        rs = np.inf if avg_l == 0 else avg_g / avg_l
        out[i] = 100 - 100 / (1 + rs)
    return out


def macd(values: np.ndarray, fast: int = 12, slow: int = 26, signal_p: int = 9):
    if fast >= slow:
        raise ValueError("fast must be < slow")
    e_fast = ema(values, fast)
    e_slow = ema(values, slow)
    macd_line = e_fast - e_slow
    # Signal line: EMA of macd_line starting once macd_line has `signal_p`
    # non-NaN values in a row (from index slow-1 onward).
    n = len(values)
    sig = np.full(n, np.nan)
    hist = np.full(n, np.nan)
    seed_start = slow - 1
    if n >= seed_start + signal_p:
        seed = macd_line[seed_start : seed_start + signal_p].mean()
        sig[seed_start + signal_p - 1] = seed
        alpha = 2.0 / (signal_p + 1)
        for i in range(seed_start + signal_p, n):
            sig[i] = alpha * macd_line[i] + (1 - alpha) * sig[i - 1]
        hist[seed_start + signal_p - 1 :] = (
            macd_line[seed_start + signal_p - 1 :] - sig[seed_start + signal_p - 1 :]
        )
    return {"macd": macd_line, "signal": sig, "hist": hist}


def adx(h: np.ndarray, l: np.ndarray, c: np.ndarray, period: int = 14):
    n = len(c)
    plus_dm = np.zeros(n)
    minus_dm = np.zeros(n)
    tr = true_range(h, l, c)
    if n > 1:
        up = h[1:] - h[:-1]
        down = l[:-1] - l[1:]
        plus_dm[1:] = np.where((up > down) & (up > 0), up, 0.0)
        minus_dm[1:] = np.where((down > up) & (down > 0), down, 0.0)
    sm_tr = wilder_ema(tr, period)
    sm_plus = wilder_ema(plus_dm, period)
    sm_minus = wilder_ema(minus_dm, period)
    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di = np.where(sm_tr > 0, 100 * sm_plus / sm_tr, np.nan)
        minus_di = np.where(sm_tr > 0, 100 * sm_minus / sm_tr, np.nan)
        denom = plus_di + minus_di
        dx = np.where(denom > 0, 100 * np.abs(plus_di - minus_di) / denom, 0.0)
    dx_clean = np.where(np.isnan(dx), 0.0, dx)
    adx_series = wilder_ema(dx_clean, period)
    mask_until = min(period * 2 - 1, n)
    adx_series[:mask_until] = np.nan
    return {"plus_di": plus_di, "minus_di": minus_di, "adx": adx_series}
