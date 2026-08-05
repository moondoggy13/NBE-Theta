"""``theta-score-wallets`` command.

  theta-score-wallets score --as-of 2027-06-01T00:00:00Z [--horizon-days 30]
  theta-score-wallets walkforward --start ... --end ... [--step-days 14]

`score` writes wallet_score_snapshots + wallet_tier_snapshots at a
point in time. `walkforward` runs the rolling out-of-sample evaluation
and prints the lift over baselines — the alpha gate's headline number.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import typer

from nbe_theta.analytics.cli_helpers import parse_utc
from nbe_theta.analytics.pipeline import load_and_build
from nbe_theta.analytics.scorer import assign_tier, score_universe
from nbe_theta.analytics.store import PostgresAnalyticsStore
from nbe_theta.backtest.walkforward import attach_out_of_sample, run_walk_forward
from nbe_theta.common.config import get_settings
from nbe_theta.common.db import connect
from nbe_theta.common.logging import configure_logging, get_logger

app = typer.Typer(add_completion=False, help="Wallet skill scoring + walk-forward validation.")


@app.command()
def score(
    as_of: str = typer.Option(
        ..., help="ISO-8601 UTC instant to score at, e.g. 2027-06-01T00:00:00Z"
    ),
    horizon_days: int = typer.Option(
        30, help="Out-of-sample window after as_of used for the Tier-A check."
    ),
) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("analytics.cli")
    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL is required")

    t = parse_utc(as_of)
    with connect(settings.database_url) as conn:
        store = PostgresAnalyticsStore(conn)
        # NOTE: the forward window is loaded separately and used ONLY to
        # fill out_of_sample_score — never to compute the as_of metrics.
        per_wallet, stats = load_and_build(store, t)
        scores = score_universe(per_wallet, t)

        horizon = timedelta(days=horizon_days)
        forward, _ = load_and_build(store, t + horizon)
        attach_out_of_sample(scores, forward, t, horizon)

        for sc in scores:
            store.upsert_score(sc)
            tier, rationale = assign_tier(sc)
            store.upsert_tier(sc.wallet, t, tier, rationale)
        store.commit()

    tiers = {"A": 0, "B": 0, "C": 0}
    for sc in scores:
        tier, _ = assign_tier(sc)
        tiers[tier] += 1
    log.info(
        "scoring complete",
        as_of=as_of,
        wallets=len(scores),
        episodes_scored=stats.episodes_scored,
        episodes_unresolved=stats.episodes_unresolved,
        tier_a=tiers["A"],
        tier_b=tiers["B"],
        tier_c=tiers["C"],
    )


@app.command()
def walkforward(
    start: str = typer.Option(..., help="ISO-8601 UTC start of the rolling evaluation."),
    end: str = typer.Option(..., help="ISO-8601 UTC end."),
    step_days: int = typer.Option(14, help="Days between folds."),
    horizon_days: int = typer.Option(30, help="Out-of-sample window per fold."),
    top_n: int = typer.Option(10, help="Wallets selected per fold."),
) -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    log = get_logger("analytics.cli")
    if not settings.database_url:
        raise typer.BadParameter("DATABASE_URL is required")

    t0, t1 = parse_utc(start), parse_utc(end)
    with connect(settings.database_url) as conn:
        store = PostgresAnalyticsStore(conn)
        # Load once at the far end; every fold re-filters to its own
        # as_of, so no fold can see past its horizon.
        per_wallet, stats = load_and_build(store, t1)

    result = run_walk_forward(
        per_wallet,
        start=t0,
        end=t1,
        step=timedelta(days=step_days),
        horizon=timedelta(days=horizon_days),
        top_n=top_n,
    )
    log.info(
        "walk-forward complete",
        folds=len(result.folds),
        episodes_scored=stats.episodes_scored,
        mean_selected_edge=result.mean_selected_edge,
        mean_baseline_edge=result.mean_baseline_edge,
        lift=result.lift,
        mean_persistence=result.mean_persistence,
    )
    typer.echo("")
    typer.echo("=== ALPHA GATE ===")
    typer.echo(f"folds:                {len(result.folds)}")
    typer.echo(f"selected edge:        {result.mean_selected_edge}")
    typer.echo(f"universe baseline:    {result.mean_baseline_edge}")
    typer.echo(f"lift (selected−base): {result.lift}")
    typer.echo(f"persistence:          {result.mean_persistence}")
    typer.echo("")
    typer.echo(
        "A non-positive lift means wallet selection adds nothing over the "
        "universe. Per the plan, that is a STOP — replan before investing "
        "in the chain indexer or execution stack."
    )


def _now() -> datetime:
    from datetime import UTC

    return datetime.now(tz=UTC)


if __name__ == "__main__":
    app()
