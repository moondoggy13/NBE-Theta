"""Persistence for the selection layer (migration 015).

Writes classifications, copyability snapshots, clusters, policies, and
cohort decisions. In-memory twin backs the unit tests.

One rule runs through all of it: **an exclusion is a row, not an
absence.** A wallet that failed a gate is written with its `checks` and
`reason`. Deleting it would make "why is the feeder set empty?"
unanswerable, and that question is the one an operator asks first.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import psycopg

from nbe_theta.analytics.clustering import Cluster
from nbe_theta.analytics.cohort import CohortDecision, CohortPolicy
from nbe_theta.analytics.copyability import CopyabilityScore
from nbe_theta.analytics.taxonomy import Classification


class CohortStore(ABC):
    @abstractmethod
    def record_classifications(self, rows: list[Classification]) -> int: ...

    @abstractmethod
    def record_copyability(self, rows: list[CopyabilityScore]) -> int: ...

    @abstractmethod
    def record_clusters(self, clusters: list[Cluster], *, as_of: datetime, model: str) -> int: ...

    @abstractmethod
    def upsert_policy(self, policy: CohortPolicy, *, as_of: datetime) -> str: ...

    @abstractmethod
    def record_cohort(
        self, decisions: list[CohortDecision], *, as_of: datetime, policy_version: str
    ) -> int: ...


@dataclass
class InMemoryCohortStore(CohortStore):
    classifications: list[Classification] = field(default_factory=list)
    copyability: list[CopyabilityScore] = field(default_factory=list)
    clusters: list[Cluster] = field(default_factory=list)
    policies: dict[str, dict[str, Any]] = field(default_factory=dict)
    cohort: list[CohortDecision] = field(default_factory=list)

    def record_classifications(self, rows: list[Classification]) -> int:
        self.classifications.extend(rows)
        return len(rows)

    def record_copyability(self, rows: list[CopyabilityScore]) -> int:
        self.copyability.extend(rows)
        return len(rows)

    def record_clusters(self, clusters: list[Cluster], *, as_of: datetime, model: str) -> int:
        self.clusters.extend(clusters)
        return len(clusters)

    def upsert_policy(self, policy: CohortPolicy, *, as_of: datetime) -> str:
        self.policies[policy.version] = {
            "hash": policy.policy_hash(),
            "params": policy.payload(),
        }
        return policy.version

    def record_cohort(
        self, decisions: list[CohortDecision], *, as_of: datetime, policy_version: str
    ) -> int:
        self.cohort.extend(decisions)
        return len(decisions)


class PostgresCohortStore(CohortStore):
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def _cur(self) -> psycopg.Cursor:
        return self._conn.cursor()

    def record_classifications(self, rows: list[Classification]) -> int:
        if not rows:
            return 0
        with self._cur() as cur:
            for c in rows:
                cur.execute(
                    "insert into event_classifications (venue, venue_event_id, "
                    "classifier_version, is_sports, category, evidence) "
                    "values ('polymarket',%s,%s,%s,%s,%s::jsonb) "
                    "on conflict (venue, venue_event_id, classifier_version) do update set "
                    "is_sports=excluded.is_sports, category=excluded.category, "
                    "evidence=excluded.evidence, classified_at=now()",
                    (
                        c.venue_event_id,
                        c.classifier_version,
                        c.is_sports,
                        c.category,
                        json.dumps(c.evidence),
                    ),
                )
        return len(rows)

    def record_copyability(self, rows: list[CopyabilityScore]) -> int:
        if not rows:
            return 0
        with self._cur() as cur:
            for s in rows:
                cur.execute(
                    "insert into wallet_copyability_snapshots (wallet, as_of, model_version, "
                    "delay_seconds, n_entries, n_measured, copyable_fraction, adverse_drift, "
                    "median_slippage, median_spread, copyability, rationale) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb) "
                    "on conflict (wallet, as_of, model_version, delay_seconds) do update set "
                    "n_entries=excluded.n_entries, n_measured=excluded.n_measured, "
                    "copyable_fraction=excluded.copyable_fraction, "
                    "adverse_drift=excluded.adverse_drift, "
                    "median_slippage=excluded.median_slippage, "
                    "median_spread=excluded.median_spread, "
                    "copyability=excluded.copyability, rationale=excluded.rationale",
                    (
                        s.wallet,
                        s.as_of,
                        s.model_version,
                        s.delay_seconds,
                        s.n_entries,
                        s.n_measured,
                        s.copyable_fraction,
                        s.adverse_drift,
                        s.median_slippage,
                        s.median_spread,
                        s.copyability,
                        json.dumps(s.rationale),
                    ),
                )
        return len(rows)

    def record_clusters(self, clusters: list[Cluster], *, as_of: datetime, model: str) -> int:
        if not clusters:
            return 0
        with self._cur() as cur:
            for c in clusters:
                cur.execute(
                    "insert into wallet_clusters (model_version, as_of, cluster_key, size, "
                    "max_pair_score, evidence) values (%s,%s,%s,%s,%s,%s::jsonb) "
                    "on conflict (model_version, as_of, cluster_key) do update set "
                    "size=excluded.size, max_pair_score=excluded.max_pair_score, "
                    "evidence=excluded.evidence "
                    "returning id",
                    (model, as_of, c.cluster_key, c.size, c.max_pair_score, json.dumps(c.evidence)),
                )
                row = cur.fetchone()
                if row is None:
                    continue
                cluster_id = row[0]
                # Membership is replaced wholesale: a wallet that left the
                # cluster must not linger as a stale member.
                cur.execute("delete from wallet_cluster_members where cluster_id=%s", (cluster_id,))
                for w in c.wallets:
                    cur.execute(
                        "insert into wallet_cluster_members (cluster_id, wallet) values (%s,%s) "
                        "on conflict do nothing",
                        (cluster_id, w),
                    )
        return len(clusters)

    def upsert_policy(self, policy: CohortPolicy, *, as_of: datetime) -> str:
        with self._cur() as cur:
            cur.execute(
                "insert into scoring_policies (version, policy_hash, params) "
                "values (%s,%s,%s::jsonb) "
                "on conflict (version) do update set "
                "policy_hash=excluded.policy_hash, params=excluded.params "
                "returning version",
                (policy.version, policy.policy_hash(), json.dumps(policy.payload())),
            )
            row = cur.fetchone()
        return str(row[0]) if row else policy.version

    def record_cohort(
        self, decisions: list[CohortDecision], *, as_of: datetime, policy_version: str
    ) -> int:
        if not decisions:
            return 0
        with self._cur() as cur:
            for d in decisions:
                facts = d.facts or {}
                notional = facts.get("traded_notional")
                cur.execute(
                    "insert into wallet_cohort (wallet, as_of, policy_version, status, "
                    "cluster_key, skill_score, copyability, rank_score, rank, n_active_days, "
                    "n_closed_markets, traded_notional, checks, reason) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s) "
                    "on conflict (wallet, as_of, policy_version) do update set "
                    "status=excluded.status, cluster_key=excluded.cluster_key, "
                    "skill_score=excluded.skill_score, copyability=excluded.copyability, "
                    "rank_score=excluded.rank_score, rank=excluded.rank, "
                    "n_active_days=excluded.n_active_days, "
                    "n_closed_markets=excluded.n_closed_markets, "
                    "traded_notional=excluded.traded_notional, checks=excluded.checks, "
                    "reason=excluded.reason",
                    (
                        d.wallet,
                        as_of,
                        policy_version,
                        d.status,
                        d.cluster_key,
                        d.skill_score,
                        d.copyability,
                        d.rank_score,
                        d.rank,
                        facts.get("n_active_days"),
                        facts.get("n_closed_markets"),
                        notional,
                        json.dumps(d.checks),
                        d.reason,
                    ),
                )
        return len(decisions)

    # ── reads ─────────────────────────────────────────────────────────

    def feeder_set(self, *, as_of: datetime, policy_version: str) -> list[str]:
        with self._cur() as cur:
            cur.execute(
                "select wallet from wallet_cohort "
                "where as_of=%s and policy_version=%s and status='feeder' "
                "order by rank nulls last",
                (as_of, policy_version),
            )
            return [r[0] for r in cur.fetchall()]

    def latest_cohort_as_of(self, policy_version: str) -> datetime | None:
        with self._cur() as cur:
            cur.execute(
                "select max(as_of) from wallet_cohort where policy_version=%s",
                (policy_version,),
            )
            row = cur.fetchone()
        return row[0] if row and row[0] else None
