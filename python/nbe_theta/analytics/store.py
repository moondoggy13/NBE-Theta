"""Analytics persistence: load trades/resolutions, write snapshots.

Loading is `as_of`-aware at the SQL level (`occurred_at <= as_of`) so
the no-look-ahead guarantee is enforced twice — once in the query, once
in `scorer.filter_as_of`. Belt and braces: this is the property that
makes or breaks walk-forward validity.
"""

from __future__ import annotations

import json
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

import psycopg

from nbe_theta.analytics.scorer import WalletScore
from nbe_theta.ledger.entries import TradeRow


@dataclass(frozen=True)
class ResolutionRow:
    condition_id: str
    outcome_token_id: str
    price: Decimal  # 0 or 1 for a settled binary outcome
    resolved_at: datetime
    event_cluster_id: str | None


class AnalyticsStore(ABC):
    @abstractmethod
    def commit(self) -> None: ...

    @abstractmethod
    def load_trades(self, as_of: datetime, wallets: list[str] | None = None) -> list[TradeRow]: ...

    @abstractmethod
    def load_resolutions(self, as_of: datetime) -> list[ResolutionRow]: ...

    @abstractmethod
    def upsert_score(self, score: WalletScore) -> None: ...

    @abstractmethod
    def upsert_tier(
        self, wallet: str, as_of: datetime, tier: str, rationale: dict[str, Any]
    ) -> None: ...


@dataclass
class InMemoryAnalyticsStore(AnalyticsStore):
    trades: list[TradeRow] = field(default_factory=list)
    resolutions: list[ResolutionRow] = field(default_factory=list)
    scores: dict[tuple[str, datetime, str], WalletScore] = field(default_factory=dict)
    tiers: dict[tuple[str, datetime], tuple[str, dict[str, Any]]] = field(default_factory=dict)

    def commit(self) -> None:
        pass

    def load_trades(self, as_of: datetime, wallets: list[str] | None = None) -> list[TradeRow]:
        rows = [t for t in self.trades if t.occurred_at <= as_of]
        if wallets is not None:
            allow = set(wallets)
            rows = [t for t in rows if t.wallet in allow]
        return rows

    def load_resolutions(self, as_of: datetime) -> list[ResolutionRow]:
        return [r for r in self.resolutions if r.resolved_at <= as_of]

    def upsert_score(self, score: WalletScore) -> None:
        self.scores[(score.wallet, score.as_of, score.model_version)] = score

    def upsert_tier(
        self, wallet: str, as_of: datetime, tier: str, rationale: dict[str, Any]
    ) -> None:
        self.tiers[(wallet, as_of)] = (tier, rationale)


class PostgresAnalyticsStore(AnalyticsStore):
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def commit(self) -> None:
        self._conn.commit()

    def load_trades(self, as_of: datetime, wallets: list[str] | None = None) -> list[TradeRow]:
        sql = (
            "select source_trade_id, wallet, condition_id, outcome_token_id, side, "
            "price, quantity, notional, occurred_at from venue_trades "
            "where venue='polymarket' and occurred_at <= %s"
        )
        params: list[Any] = [as_of]
        if wallets:
            sql += " and wallet = any(%s)"
            params.append(wallets)
        sql += " order by occurred_at"
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            return [
                TradeRow(
                    source_trade_id=str(r[0]),
                    wallet=str(r[1]),
                    condition_id=str(r[2]),
                    outcome_token_id=str(r[3]),
                    side=str(r[4]),
                    price=Decimal(str(r[5])),
                    quantity=Decimal(str(r[6])),
                    notional=Decimal(str(r[7])),
                    occurred_at=r[8],
                )
                for r in cur.fetchall()
            ]

    def load_resolutions(self, as_of: datetime) -> list[ResolutionRow]:
        """Settled outcomes observable at as_of.

        The event cluster defaults to the market's venue_event_id — the
        best available grouping until a dedicated real-world-event
        clustering lands. That is intentionally coarse-but-honest:
        under-clustering would inflate significance, so grouping by event
        is the conservative direction.
        """

        with self._conn.cursor() as cur:
            # resolution_price NOT NULL is the filter that keeps
            # unsettled (or un-captured) outcomes out of scoring
            # entirely — no sentinel, no imputation.
            cur.execute(
                "select m.condition_id, o.outcome_token_id, o.resolution_price, "
                "       m.resolved_at, m.venue_event_id "
                "from markets m join outcomes o "
                "  on o.venue = m.venue and o.venue_market_id = m.venue_market_id "
                "where m.resolved = true and m.resolved_at is not null "
                "  and m.resolved_at <= %s and o.resolution_price is not null",
                (as_of,),
            )
            rows = cur.fetchall()
        return [
            ResolutionRow(
                condition_id=str(r[0]),
                outcome_token_id=str(r[1]),
                price=Decimal(str(r[2])),
                resolved_at=r[3],
                event_cluster_id=str(r[4]) if r[4] is not None else None,
            )
            for r in rows
        ]

    def upsert_score(self, score: WalletScore) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "insert into wallet_score_snapshots (wallet, as_of, model_version, "
                "population_version, n_fills, n_episodes, n_effective_events, "
                "posterior_accuracy_mean, posterior_accuracy_lcb, mean_excess_edge, edge_lcb, "
                "brier_delta, clv, markout_5m, markout_1h, markout_24h, drawdown, "
                "profit_concentration, fdr_q, out_of_sample_score, skill_score, "
                "confidence_score, rationale) values "
                "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (wallet, as_of, model_version) do update set "
                "population_version=excluded.population_version, n_fills=excluded.n_fills, "
                "n_episodes=excluded.n_episodes, "
                "n_effective_events=excluded.n_effective_events, "
                "posterior_accuracy_mean=excluded.posterior_accuracy_mean, "
                "posterior_accuracy_lcb=excluded.posterior_accuracy_lcb, "
                "mean_excess_edge=excluded.mean_excess_edge, edge_lcb=excluded.edge_lcb, "
                "brier_delta=excluded.brier_delta, clv=excluded.clv, "
                "markout_5m=excluded.markout_5m, markout_1h=excluded.markout_1h, "
                "markout_24h=excluded.markout_24h, drawdown=excluded.drawdown, "
                "profit_concentration=excluded.profit_concentration, fdr_q=excluded.fdr_q, "
                "out_of_sample_score=excluded.out_of_sample_score, "
                "skill_score=excluded.skill_score, confidence_score=excluded.confidence_score, "
                "rationale=excluded.rationale",
                (
                    score.wallet,
                    score.as_of,
                    score.model_version,
                    score.population_version,
                    score.n_fills,
                    score.n_episodes,
                    score.n_effective_events,
                    score.posterior_accuracy_mean,
                    score.posterior_accuracy_lcb,
                    score.mean_excess_edge,
                    score.edge_lcb,
                    score.brier_delta,
                    score.clv,
                    score.markout_5m,
                    score.markout_1h,
                    score.markout_24h,
                    score.drawdown,
                    score.profit_concentration,
                    score.fdr_q,
                    score.out_of_sample_score,
                    score.skill_score,
                    score.confidence_score,
                    json.dumps(score.rationale, default=str),
                ),
            )

    def upsert_tier(
        self, wallet: str, as_of: datetime, tier: str, rationale: dict[str, Any]
    ) -> None:
        with self._conn.cursor() as cur:
            cur.execute(
                "insert into wallet_tier_snapshots (id, wallet, as_of, tier, rationale) "
                "values (%s,%s,%s,%s,%s) on conflict (wallet, as_of) do update set "
                "tier=excluded.tier, rationale=excluded.rationale",
                (
                    str(uuid.uuid4()),
                    wallet,
                    as_of,
                    tier,
                    json.dumps(rationale, default=str),
                ),
            )
