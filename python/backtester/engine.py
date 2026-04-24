"""Vectorized backtest engine mirroring src/lib/backtest/engine.ts.

Walks bar-by-bar (not fully vectorized) so intra-bar stop/target checks
and ensemble ordering match the TS reference. Python's advantage is in
parameter sweeps via joblib, not per-run speed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

import numpy as np
import pandas as pd


MIN_PER_YEAR = 365 * 24 * 60


@dataclass
class Trade:
    entry_ts: int
    exit_ts: int
    side: str
    entry_price: float
    exit_price: float
    qty: float
    pnl: float
    reason: str


@dataclass
class BacktestResult:
    equity: pd.DataFrame
    trades: list[Trade] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)


def _apply_slippage(price: float, side: str, slip: float) -> float:
    return price * (1 + slip) if side == "buy" else price * (1 - slip)


def _realized_pnl(pos: dict, exit_px: float, fee: float) -> float:
    if pos["side"] == "long":
        gross = (exit_px - pos["entry_price"]) * pos["qty"]
    else:
        gross = (pos["entry_price"] - exit_px) * pos["qty"]
    return gross - pos["qty"] * exit_px * fee


def run_backtest(
    candles: pd.DataFrame,
    strategy_signals: dict[str, pd.DataFrame],
    weights: dict[str, float],
    *,
    start_equity: float = 25_000,
    risk_per_trade: float = 0.02,
    slippage_bps: float = 1,
    fee_bps: float = 5,
    bar_minutes: int = 1,
    long_threshold: float = 0.25,
    short_threshold: float = 0.25,
) -> BacktestResult:
    """
    candles: DataFrame with columns ts (ms), o, h, l, c, v.
    strategy_signals: dict of {strategy_id: DataFrame with columns
        side, score, confidence, stop, target}, indexed same as candles.
    """
    slip = slippage_bps / 10_000
    fee = fee_bps / 10_000
    equity = start_equity
    position: dict | None = None
    trades: list[Trade] = []
    eq_rows: list[tuple[int, float]] = []

    total_weight = sum(weights.values())
    ids = list(weights.keys())

    for i, row in candles.iterrows():
        ts, o, h, l, c = int(row.ts), row.o, row.h, row.l, row.c

        # Intra-bar stop/target
        if position:
            exit_info = None
            if position["side"] == "long":
                if l <= position["stop"]:
                    exit_info = (position["stop"], "stop")
                elif h >= position["target"]:
                    exit_info = (position["target"], "target")
            else:
                if h >= position["stop"]:
                    exit_info = (position["stop"], "stop")
                elif l <= position["target"]:
                    exit_info = (position["target"], "target")
            if exit_info:
                px, reason = exit_info
                fill = _apply_slippage(px, "sell" if position["side"] == "long" else "buy", slip)
                pnl = _realized_pnl(position, fill, fee)
                equity += pnl
                trades.append(Trade(position["entry_ts"], ts, position["side"], position["entry_price"], fill, position["qty"], pnl, reason))
                position = None

        # Aggregate ensemble decision
        weighted_score = 0.0
        weighted_conf = 0.0
        t_weight = 0.0
        any_long_hint = None
        any_short_hint = None
        for sid in ids:
            sdf = strategy_signals[sid]
            side = sdf.at[i, "side"] if i in sdf.index else "null"
            if side in ("null", None) or (isinstance(side, float) and np.isnan(side)):
                continue
            w = weights[sid]
            conf = sdf.at[i, "confidence"]
            score = sdf.at[i, "score"]
            dir_mult = 1 if side == "long" else -1 if side == "short" else 0
            weighted_score += w * score * conf * (1 if dir_mult != 0 else 0)
            weighted_conf += w * conf
            t_weight += w
            if side == "long" and any_long_hint is None:
                any_long_hint = (sdf.at[i, "stop"], sdf.at[i, "target"])
            if side == "short" and any_short_hint is None:
                any_short_hint = (sdf.at[i, "stop"], sdf.at[i, "target"])
        if t_weight == 0:
            decision = "flat"
            norm_score = 0.0
        else:
            norm_score = weighted_score / t_weight
            decision = "long" if norm_score >= long_threshold else "short" if norm_score <= -short_threshold else "flat"

        # Signal-driven exit
        if position and (
            decision == "flat"
            or (position["side"] == "long" and decision == "short")
            or (position["side"] == "short" and decision == "long")
        ):
            fill = _apply_slippage(c, "sell" if position["side"] == "long" else "buy", slip)
            pnl = _realized_pnl(position, fill, fee)
            equity += pnl
            trades.append(Trade(position["entry_ts"], ts, position["side"], position["entry_price"], fill, position["qty"], pnl, "signal"))
            position = None

        # Entry
        if position is None and decision in ("long", "short"):
            hint = any_long_hint if decision == "long" else any_short_hint
            entry = _apply_slippage(c, "buy" if decision == "long" else "sell", slip)
            if hint and not np.isnan(hint[0]) and not np.isnan(hint[1]):
                stop, target = hint
            else:
                stop = entry * 0.98 if decision == "long" else entry * 1.02
                target = entry * 1.04 if decision == "long" else entry * 0.96
            risk_unit = abs(entry - stop)
            if risk_unit > 0:
                qty = (equity * risk_per_trade) / risk_unit
                position = {"side": decision, "entry_ts": ts, "entry_price": entry, "qty": qty, "stop": stop, "target": target}
                equity -= qty * entry * fee

        # MtM equity
        if position:
            mtm = equity + (
                (c - position["entry_price"]) * position["qty"]
                if position["side"] == "long"
                else (position["entry_price"] - c) * position["qty"]
            )
        else:
            mtm = equity
        eq_rows.append((ts, mtm))

    # Final flatten
    if position and len(candles):
        last = candles.iloc[-1]
        fill = _apply_slippage(last.c, "sell" if position["side"] == "long" else "buy", slip)
        pnl = _realized_pnl(position, fill, fee)
        equity += pnl
        trades.append(Trade(position["entry_ts"], int(last.ts), position["side"], position["entry_price"], fill, position["qty"], pnl, "eod"))
        eq_rows[-1] = (eq_rows[-1][0], equity)

    equity_df = pd.DataFrame(eq_rows, columns=["ts", "equity"])
    return BacktestResult(equity=equity_df, trades=trades, metrics=_metrics(equity_df, trades, start_equity, bar_minutes))


def _metrics(equity: pd.DataFrame, trades: list[Trade], start_equity: float, bar_minutes: int) -> dict[str, float]:
    if len(equity) < 2:
        return {"total_return_pct": 0, "sharpe": 0, "sortino": 0, "max_drawdown_pct": 0, "hit_rate": 0, "trades": 0, "final_equity": start_equity}
    final = float(equity.equity.iloc[-1])
    returns = equity.equity.pct_change().dropna().to_numpy()
    mean_r = returns.mean() if len(returns) else 0
    sd = returns.std(ddof=0) if len(returns) else 0
    downside = np.sqrt((np.where(returns < 0, returns, 0) ** 2).mean()) if len(returns) else 0
    annualizer = np.sqrt(MIN_PER_YEAR / bar_minutes)
    sharpe = 0 if sd == 0 else mean_r / sd * annualizer
    sortino = 0 if downside == 0 else mean_r / downside * annualizer
    peak = equity.equity.cummax()
    dd = (peak - equity.equity) / peak
    max_dd = float(dd.max())
    wins = sum(1 for t in trades if t.pnl > 0)
    hit = wins / len(trades) if trades else 0
    return {
        "total_return_pct": (final - start_equity) / start_equity * 100,
        "sharpe": float(sharpe),
        "sortino": float(sortino),
        "max_drawdown_pct": max_dd * 100,
        "hit_rate": hit,
        "trades": len(trades),
        "final_equity": final,
        "start_equity": start_equity,
    }


def eval_strategies(candles: pd.DataFrame, strategies: Iterable[Any]) -> dict[str, pd.DataFrame]:
    out: dict[str, pd.DataFrame] = {}
    h = candles.h.to_numpy()
    l = candles.l.to_numpy()
    c = candles.c.to_numpy()
    for s in strategies:
        res = s.evaluate(h, l, c)
        out[s.id] = pd.DataFrame(res, index=candles.index)
    return out
