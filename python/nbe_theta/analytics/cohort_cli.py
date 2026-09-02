"""``theta-cohort`` command — the selection layer.

  theta-cohort classify            classify events as sports / non-sports
  theta-cohort cluster --as-of …   build correlated-wallet clusters
  theta-cohort select --as-of …    evaluate eligibility, promote a feeder set
  theta-cohort show --as-of …      print the current cohort + why
  theta-cohort budget              print the polling-budget arithmetic

`select` is the one that matters. It answers the operator's question —
*which wallets are we mirroring, and what would make one drop out?* —
and it writes an exclusion row with a named reason for every wallet that
did not make it, so an empty feeder set is always explained.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import typer

from nbe_theta.analytics.clustering import (
    MODEL_VERSION as CLUSTER_MODEL,
)
from nbe_theta.analytics.clustering import (
    Action,
    build_clusters,
)
from nbe_theta.analytics.cohort import CohortPolicy, WalletFacts, select, summarize
from nbe_theta.analytics.cohort_store import PostgresCohortStore
from nbe_theta.analytics.copyability import CopyabilityScore
from nbe_theta.analytics.scorer import WalletScore
from nbe_theta.analytics.taxonomy import CLASSIFIER_VERSION, classify
from nbe_theta.common.config import get_settings
from nbe_theta.common.db import connect
from nbe_theta.common.logging import configure_logging, get_logger
from nbe_theta.ingest.budget import adopted_schedule, spec_schedule

app = typer.Typer(add_completion=False, help="Polymarket cohort selection.")
log = get_logger(__name__)


def _parse_as_of(value: str | None) -> datetime:
    if not value:
        return datetime.now(tz=UTC)
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


@app.command()
def budget() -> None:
    """Print the polling-budget arithmetic from ADR-0002 §E."""

    typer.echo("--- spec as written ---")
    typer.echo(spec_schedule().explain())
    typer.echo("")
    typer.echo("--- adopted ---")
    typer.echo(adopted_schedule().explain())


@app.command()
def classify_events(
    limit: int = typer.Option(5000, help="Maximum events to classify in one pass."),
) -> None:
    """Classify events as sports / non-sports.

    Undecidable events get NO row. That is the fail-closed rule: a wallet
    trading them cannot be shown to trade non-sports, so it stays
    ineligible rather than being admitted on silence.
    """

    settings = get_settings()
    configure_logging(settings.log_level)
    with connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select e.venue_event_id, e.title, e.category "
                "from events e "
                "left join event_classifications c "
                "  on c.venue_event_id = e.venue_event_id "
                " and c.classifier_version = %s "
                "where c.venue_event_id is null "
                "limit %s",
                (CLASSIFIER_VERSION, limit),
            )
            rows = cur.fetchall()

        decided = []
        undecided = 0
        for event_id, title, category in rows:
            c = classify(venue_event_id=event_id, title=title, category=category)
            if c is None:
                undecided += 1
                continue
            decided.append(c)

        written = PostgresCohortStore(conn).record_classifications(decided)
        conn.commit()

    typer.echo(
        f"classified {written} event(s); {undecided} undecidable "
        f"(left unclassified on purpose — they stay ineligible)"
    )


@app.command()
def cluster(
    as_of: str = typer.Option(None, help="ISO timestamp; default now."),
    lookback_days: int = typer.Option(30, help="Co-activity lookback."),
) -> None:
    """Group wallets whose trades are not independent evidence."""

    settings = get_settings()
    configure_logging(settings.log_level)
    at = _parse_as_of(as_of)

    with connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select wallet, outcome_token_id, side, occurred_at "
                "from venue_trades "
                "where occurred_at >= %s - make_interval(days => %s) and occurred_at <= %s",
                (at, lookback_days, at),
            )
            actions: dict[str, list[Action]] = {}
            for wallet, token, side, ts in cur.fetchall():
                actions.setdefault(wallet, []).append(
                    Action(wallet=wallet, outcome_token_id=token, direction=side, occurred_at=ts)
                )

        clusters = build_clusters(actions, at)
        written = PostgresCohortStore(conn).record_clusters(clusters, as_of=at, model=CLUSTER_MODEL)
        conn.commit()

    multi = [c for c in clusters if c.size > 1]
    typer.echo(
        f"{written} cluster(s) from {len(actions)} wallet(s); "
        f"{len(multi)} contain more than one wallet"
    )
    for c in sorted(multi, key=lambda c: -c.size)[:10]:
        typer.echo(f"  {c.cluster_key}  size={c.size}  max_pair={c.max_pair_score:.2f}")


@app.command()
def select_cohort(
    as_of: str = typer.Option(None, help="ISO timestamp; default now."),
    max_feeder: int = typer.Option(150, help="Bounded active feeder set."),
    dry_run: bool = typer.Option(False, help="Evaluate and print without writing."),
) -> None:
    """Evaluate eligibility and promote the feeder set.

    Reads the latest score and copyability snapshot per wallet. Wallets
    with neither are still evaluated — and excluded with a named reason,
    which is the useful outcome.
    """

    settings = get_settings()
    configure_logging(settings.log_level)
    at = _parse_as_of(as_of)
    policy = CohortPolicy(max_feeder=max_feeder)

    with connect(settings.database_url) as conn:
        facts = _load_facts(conn, at)
        clusters = _load_clusters(conn, at)
        decisions = select(facts, policy, clusters=clusters)

        if not dry_run:
            store = PostgresCohortStore(conn)
            store.upsert_policy(policy, as_of=at)
            store.record_cohort(decisions, as_of=at, policy_version=policy.version)
            conn.commit()

    s = summarize(decisions)
    typer.echo(f"policy {policy.version} ({policy.policy_hash()[:12]})  as_of {at.isoformat()}")
    typer.echo(f"evaluated {s['total']} wallet(s): {s['by_status']}")
    if s["exclusion_reasons"]:
        typer.echo("exclusions by first failing gate:")
        for reason, n in s["exclusion_reasons"].items():
            typer.echo(f"  {reason:<24} {n}")
    if dry_run:
        typer.echo("(dry run — nothing written)")


def _load_facts(conn: Any, at: datetime) -> list[WalletFacts]:
    """Assemble per-wallet facts from the latest snapshots at or before `at`."""

    with conn.cursor() as cur:
        cur.execute(
            "select distinct on (wallet) wallet, as_of, model_version, population_version, "
            "n_fills, n_episodes, n_effective_events, posterior_accuracy_mean, "
            "posterior_accuracy_lcb, mean_excess_edge, edge_lcb, brier_delta, clv, "
            "markout_5m, markout_1h, markout_24h, drawdown, profit_concentration, fdr_q, "
            "out_of_sample_score, skill_score, confidence_score, rationale "
            "from wallet_score_snapshots where as_of <= %s "
            "order by wallet, as_of desc",
            (at,),
        )
        scores = {
            r[0]: WalletScore(
                wallet=r[0],
                as_of=r[1],
                model_version=r[2],
                population_version=r[3],
                n_fills=r[4],
                n_episodes=r[5],
                n_effective_events=r[6],
                posterior_accuracy_mean=r[7],
                posterior_accuracy_lcb=r[8],
                mean_excess_edge=r[9],
                edge_lcb=r[10],
                brier_delta=r[11],
                clv=r[12],
                markout_5m=r[13],
                markout_1h=r[14],
                markout_24h=r[15],
                drawdown=r[16],
                profit_concentration=r[17],
                fdr_q=r[18],
                out_of_sample_score=r[19],
                skill_score=r[20],
                confidence_score=r[21],
                rationale=r[22] or {},
            )
            for r in cur.fetchall()
        }

        cur.execute(
            "select distinct on (wallet) wallet, as_of, model_version, delay_seconds, "
            "n_entries, n_measured, copyable_fraction, adverse_drift, median_slippage, "
            "median_spread, copyability, rationale "
            "from wallet_copyability_snapshots where as_of <= %s "
            "order by wallet, as_of desc",
            (at,),
        )
        cops = {
            r[0]: CopyabilityScore(
                wallet=r[0],
                as_of=r[1],
                model_version=r[2],
                delay_seconds=r[3],
                n_entries=r[4],
                n_measured=r[5],
                copyable_fraction=r[6],
                adverse_drift=r[7],
                median_slippage=r[8],
                median_spread=r[9],
                copyability=r[10],
                rationale=r[11] or {},
            )
            for r in cur.fetchall()
        }

        # Activity facts, plus the share of activity in markets we could
        # classify as sports. A wallet whose markets are largely
        # unclassified gets sports_share = NULL and fails the scope gate.
        cur.execute(
            "select t.wallet, "
            "       count(distinct date_trunc('day', t.occurred_at)) as active_days, "
            "       count(distinct t.condition_id) as markets, "
            "       coalesce(sum(t.notional), 0) as notional, "
            "       count(*) filter (where c.is_sports is not null) as classified, "
            "       count(*) filter (where c.is_sports) as sports, "
            "       count(*) as total "
            "from venue_trades t "
            "left join markets m on m.condition_id = t.condition_id "
            "left join event_classifications c "
            "  on c.venue_event_id = m.venue_event_id and c.classifier_version = %s "
            "where t.occurred_at <= %s "
            "group by t.wallet",
            (CLASSIFIER_VERSION, at),
        )
        facts: list[WalletFacts] = []
        for wallet, days, markets, notional, classified, sports, total in cur.fetchall():
            # Require most of the wallet's activity to be classified
            # before we will assert anything about its sports share.
            coverage = (classified / total) if total else 0.0
            sports_share = (sports / classified) if classified and coverage >= 0.8 else None
            facts.append(
                WalletFacts(
                    wallet=wallet,
                    n_active_days=int(days or 0),
                    n_closed_markets=int(markets or 0),
                    traded_notional=Decimal(str(notional or 0)),
                    sports_share=sports_share,
                    score=scores.get(wallet),
                    copyability=cops.get(wallet),
                )
            )
    return facts


def _load_clusters(conn: Any, at: datetime) -> dict[str, str]:
    with conn.cursor() as cur:
        cur.execute(
            "select c.cluster_key, m.wallet from wallet_clusters c "
            "join wallet_cluster_members m on m.cluster_id = c.id "
            "where c.as_of = (select max(as_of) from wallet_clusters where as_of <= %s)",
            (at,),
        )
        return {wallet: key for key, wallet in cur.fetchall()}


@app.command()
def show(
    as_of: str = typer.Option(None, help="ISO timestamp; default the latest run."),
    status: str = typer.Option("feeder", help="feeder | cohort | excluded | all"),
    limit: int = typer.Option(50),
) -> None:
    """Print the cohort and, for exclusions, why."""

    settings = get_settings()
    configure_logging(settings.log_level)
    policy = CohortPolicy()

    with connect(settings.database_url) as conn:
        store = PostgresCohortStore(conn)
        at = _parse_as_of(as_of) if as_of else store.latest_cohort_as_of(policy.version)
        if at is None:
            typer.echo("no cohort runs recorded")
            raise typer.Exit(code=1)
        with conn.cursor() as cur:
            if status == "all":
                cur.execute(
                    "select wallet, status, rank, skill_score, copyability, reason "
                    "from wallet_cohort where as_of=%s order by rank nulls last limit %s",
                    (at, limit),
                )
            else:
                cur.execute(
                    "select wallet, status, rank, skill_score, copyability, reason "
                    "from wallet_cohort where as_of=%s and status=%s "
                    "order by rank nulls last limit %s",
                    (at, status, limit),
                )
            rows = cur.fetchall()

    typer.echo(f"cohort as of {at.isoformat()}  ({status})")
    for wallet, st, rank, skill, cop, reason in rows:
        rank_s = f"#{rank}" if rank else "  -"
        skill_s = f"{skill:+.4f}" if skill is not None else "    -"
        cop_s = f"{cop:.2f}" if cop is not None else "  -"
        tail = f"  {reason}" if reason else ""
        typer.echo(f"  {rank_s:>4} {wallet}  skill={skill_s}  copy={cop_s}  {st}{tail}")
