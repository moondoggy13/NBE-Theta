"""PostgresCohortStore integration test (migration 015).

Covers the SQL: classification upserts, copyability snapshots, cluster
membership replacement, policy hashing, and the cohort rows that carry
every exclusion reason. Skipped unless DATABASE_URL is set.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any

import pytest

from nbe_theta.analytics.clustering import Cluster
from nbe_theta.analytics.cohort import CohortDecision, CohortPolicy
from nbe_theta.analytics.cohort_store import PostgresCohortStore
from nbe_theta.analytics.copyability import CopyabilityScore
from nbe_theta.analytics.taxonomy import Classification
from nbe_theta.common.db import connect

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; PostgresCohortStore integration test skipped",
)

T0 = datetime(2027, 6, 1, 12, 0, 0, tzinfo=UTC)


def _clean(conn: Any) -> None:
    with conn.cursor() as cur:
        cur.execute("delete from wallet_cohort where wallet like 'pg-%'")
        cur.execute(
            "delete from wallet_cluster_members where cluster_id in "
            "(select id from wallet_clusters where cluster_key like 'pg-%')"
        )
        cur.execute("delete from wallet_clusters where cluster_key like 'pg-%'")
        cur.execute("delete from wallet_copyability_snapshots where wallet like 'pg-%'")
        cur.execute("delete from event_classifications where venue_event_id like 'pg-%'")
        cur.execute("delete from scoring_policies where version like 'pg-%'")
    conn.commit()


def test_classifications_upsert_by_classifier_version() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresCohortStore(conn)
        store.record_classifications(
            [
                Classification(
                    venue_event_id="pg-e1",
                    is_sports=True,
                    category="nfl",
                    evidence={"reason": "category"},
                )
            ]
        )
        # Re-classifying under the SAME version corrects in place.
        store.record_classifications(
            [
                Classification(
                    venue_event_id="pg-e1",
                    is_sports=False,
                    category="politics",
                    evidence={"reason": "corrected"},
                )
            ]
        )
        conn.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select is_sports, category from event_classifications where venue_event_id='pg-e1'"
            )
            rows = cur.fetchall()
        assert len(rows) == 1
        assert rows[0][0] is False


def test_cluster_membership_is_replaced_not_accumulated() -> None:
    """A wallet that left a cluster must not linger as a stale member —
    otherwise it keeps occupying a feeder slot it no longer belongs to."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresCohortStore(conn)
        store.record_clusters(
            [Cluster(cluster_key="pg-c1", wallets=["pg-a", "pg-b", "pg-c"], max_pair_score=0.9)],
            as_of=T0,
            model="cluster-1",
        )
        store.record_clusters(
            [Cluster(cluster_key="pg-c1", wallets=["pg-a", "pg-b"], max_pair_score=0.85)],
            as_of=T0,
            model="cluster-1",
        )
        conn.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select m.wallet from wallet_clusters c "
                "join wallet_cluster_members m on m.cluster_id=c.id "
                "where c.cluster_key='pg-c1' order by m.wallet"
            )
            members = [r[0] for r in cur.fetchall()]
            cur.execute("select size from wallet_clusters where cluster_key='pg-c1'")
            size = cur.fetchone()
        assert members == ["pg-a", "pg-b"]
        assert size is not None and size[0] == 2


def test_copyability_snapshot_roundtrips_with_nulls_intact() -> None:
    """An unmeasured wallet must persist as NULL, not 0 — the difference
    decides whether we collect more data or drop the wallet."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        PostgresCohortStore(conn).record_copyability(
            [
                CopyabilityScore(
                    wallet="pg-w1",
                    as_of=T0,
                    model_version="copyability-1",
                    delay_seconds=45,
                    n_entries=5,
                    n_measured=0,
                    copyable_fraction=None,
                    adverse_drift=None,
                    median_slippage=None,
                    median_spread=None,
                    copyability=None,
                    rationale={"note": "no coverage"},
                )
            ]
        )
        conn.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select n_measured, copyable_fraction, copyability "
                "from wallet_copyability_snapshots where wallet='pg-w1'"
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == 0
        assert row[1] is None
        assert row[2] is None


def test_policy_is_stored_with_its_hash() -> None:
    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        policy = CohortPolicy(version="pg-policy-1")
        PostgresCohortStore(conn).upsert_policy(policy, as_of=T0)
        conn.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select policy_hash, params from scoring_policies where version='pg-policy-1'"
            )
            row = cur.fetchone()
        assert row is not None
        assert row[0] == policy.policy_hash()
        assert row[1]["min_copyability"] == policy.min_copyability


def test_every_decision_is_written_including_exclusions() -> None:
    """The exclusion rows are the point: they answer 'why is the feeder
    set empty?' without re-deriving anything."""

    with connect(os.environ["DATABASE_URL"]) as conn:
        _clean(conn)
        store = PostgresCohortStore(conn)
        policy = CohortPolicy(version="pg-policy-2")
        store.upsert_policy(policy, as_of=T0)
        store.record_cohort(
            [
                CohortDecision(
                    wallet="pg-good",
                    status="feeder",
                    checks={"copyable_fraction": True},
                    reason=None,
                    rank_score=0.9,
                    skill_score=0.05,
                    copyability=0.8,
                    cluster_key="pg-good",
                    rank=1,
                    facts={
                        "n_active_days": 120,
                        "n_closed_markets": 60,
                        "traded_notional": "50000",
                    },
                ),
                CohortDecision(
                    wallet="pg-bad",
                    status="excluded",
                    checks={"copyable_fraction": False},
                    reason="copyable_fraction",
                    rank_score=None,
                    skill_score=0.2,
                    copyability=0.02,
                    cluster_key="pg-bad",
                    facts={
                        "n_active_days": 200,
                        "n_closed_markets": 90,
                        "traded_notional": "900000",
                    },
                ),
            ],
            as_of=T0,
            policy_version=policy.version,
        )
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "select wallet, status, reason, checks from wallet_cohort "
                "where as_of=%s and policy_version=%s order by wallet",
                (T0, policy.version),
            )
            rows = cur.fetchall()
        assert len(rows) == 2
        bad = [r for r in rows if r[0] == "pg-bad"][0]
        assert bad[1] == "excluded"
        assert bad[2] == "copyable_fraction"
        assert bad[3]["copyable_fraction"] is False

        feeders = PostgresCohortStore(conn).feeder_set(as_of=T0, policy_version=policy.version)
        assert feeders == ["pg-good"]
