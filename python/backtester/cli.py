"""Typer CLI for Python backtester.

    uv run backtest run --strategy mean-reversion-bb --data data/btc-1m-2024.ndjson
    uv run backtest sweep --strategy mean-reversion-bb --config python/sweeps/bb.yaml
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import typer
import yaml
from rich.console import Console
from rich.table import Table

from . import engine
from .data import fetch_candles, load_ndjson
from .strategies import REGISTRY

app = typer.Typer(add_completion=False)
console = Console()


@app.command("fetch")
def cmd_fetch(
    symbol: str = typer.Option("BTC-USD"),
    interval: str = typer.Option("1m"),
    from_date: str = typer.Option(..., "--from"),
    to_date: str = typer.Option(..., "--to"),
    out: str = typer.Option(...),
):
    df = fetch_candles(symbol, interval, from_date, to_date)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for row in df.to_dict(orient="records"):
            f.write(json.dumps(row) + "\n")
    console.print(f"Wrote {len(df)} candles to {out}")


@app.command("run")
def cmd_run(
    strategy: list[str] = typer.Option(["mean-reversion-bb"], "--strategy"),
    data: str = typer.Option(...),
    start_equity: float = typer.Option(25_000),
    risk_per_trade: float = typer.Option(0.02),
    slippage_bps: float = typer.Option(1),
    fee_bps: float = typer.Option(5),
    bar_minutes: int = typer.Option(1),
    save: bool = typer.Option(False, "--save/--no-save"),
):
    for s in strategy:
        if s not in REGISTRY:
            console.print(f"[red]Unknown strategy {s}. Known: {list(REGISTRY)}[/]")
            raise typer.Exit(1)

    candles = load_ndjson(data)
    strategies = [REGISTRY[s]() for s in strategy]
    signals = engine.eval_strategies(candles, strategies)
    weights = {s: 1.0 for s in strategy}
    result = engine.run_backtest(
        candles, signals, weights,
        start_equity=start_equity,
        risk_per_trade=risk_per_trade,
        slippage_bps=slippage_bps,
        fee_bps=fee_bps,
        bar_minutes=bar_minutes,
    )
    _print_metrics(result.metrics, len(candles))
    if save:
        _save_run(strategy, data, weights, candles, result)


@app.command("sweep")
def cmd_sweep(
    strategy: str = typer.Option(...),
    data: str = typer.Option(...),
    config: str = typer.Option(...),
    start_equity: float = typer.Option(25_000),
):
    if strategy not in REGISTRY:
        console.print(f"[red]Unknown strategy {strategy}[/]")
        raise typer.Exit(1)
    with open(config) as f:
        sweep = yaml.safe_load(f)  # { params: { param_name: [v1, v2, ...] } }

    candles = load_ndjson(data)
    results = []
    import itertools

    param_names = list(sweep["params"])
    grid = list(itertools.product(*(sweep["params"][k] for k in param_names)))
    console.print(f"Sweeping {len(grid)} configurations of {strategy}")

    for combo in grid:
        overrides = dict(zip(param_names, combo))
        strat = REGISTRY[strategy](**overrides)
        signals = engine.eval_strategies(candles, [strat])
        res = engine.run_backtest(candles, signals, {strategy: 1.0}, start_equity=start_equity)
        results.append({**overrides, **res.metrics})

    import pandas as pd
    df = pd.DataFrame(results).sort_values("sharpe", ascending=False)
    console.print(df.head(20).to_string(index=False))


def _print_metrics(m: dict, n_bars: int) -> None:
    t = Table(title=f"Backtest metrics ({n_bars} bars)")
    t.add_column("metric")
    t.add_column("value", justify="right")
    for k, v in m.items():
        t.add_row(k, f"{v:.4f}" if isinstance(v, float) else str(v))
    console.print(t)


def _save_run(strategy_ids, data_path, weights, candles, result) -> None:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        console.print("[yellow]Supabase env not set; skip save[/]")
        return
    from supabase import create_client

    sb = create_client(url, key)
    from_ts = int(candles.ts.iloc[0])
    to_ts = int(candles.ts.iloc[-1])
    sb.table("backtest_runs").insert({
        "engine": "python",
        "strategy_id": "+".join(strategy_ids),
        "symbol": "BTC-USD",
        "interval": "1m",
        "params": weights,
        "from_ts": _ms_to_iso(from_ts),
        "to_ts": _ms_to_iso(to_ts),
        "metrics": result.metrics,
    }).execute()
    console.print("[green]Saved to backtest_runs[/]")


def _ms_to_iso(ms: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


if __name__ == "__main__":
    app()
