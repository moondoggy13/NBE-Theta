"""Cohort selection: who do we follow, and why.

The output of this module is the answer to the operator's only real
question — *which wallets are we mirroring, and what would make one drop
out?* Everything downstream inherits its quality, so the design choices
here matter more than anywhere else in the Signal layer.

**Eligibility is a list of vetoes, not a weighted score.**

The spec proposed a weighted sum compared to a threshold. ADR-0002 §A
shows why that shape fails: incommensurable quantities summed and
compared to a magic constant produce rules that contradict each other
(there, a `Q ≥ 0.85` source could provably never clear `S ≥ 0.75`), and
worse, they let a failing liquidity check be "made up for" by a high
skill score. Necessary conditions do not trade off against each other.

So each gate is boolean and records its own reason. A wallet is eligible
only if every gate passes, and the stored `checks` object says exactly
which one stopped it.

**Ranking is separate from eligibility.** Once a wallet is eligible, we
still need an order to fill a bounded feeder set. That ordering is a
score — but it only ever ranks wallets that have already passed every
veto, so it can never admit anyone.

**One slot per cluster.** A cluster is one opinion (see `clustering`).
The feeder set takes the best-ranked member of each cluster and skips the
rest, so five wallets from one desk cannot occupy five slots and take
five times the intended exposure.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from nbe_theta.analytics.copyability import CopyabilityScore
from nbe_theta.analytics.scorer import WalletScore

STATUS_CANDIDATE = "candidate"
STATUS_COHORT = "cohort"
STATUS_FEEDER = "feeder"
STATUS_EXCLUDED = "excluded"


@dataclass(frozen=True)
class CohortPolicy:
    """The versioned rule set. Hashed so a decision can cite it exactly.

    Defaults follow the NBE-Overlord spec, with the additions ADR-0002
    argues for: copyability and FDR survival are vetoes, and the
    non-sports classification must be *decided*, not merely not-sports.
    """

    version: str = "cohort-1"

    # Spec eligibility floors.
    min_active_days: int = 90
    min_closed_markets: int = 40
    min_traded_notional: Decimal = Decimal("10000")

    # Skill. Our statistical core rather than the spec's raw returns:
    # a positive lower bound on excess edge, surviving FDR across the
    # whole screened universe. Screening 1,000 wallets at a per-wallet
    # threshold selects ~50 noise wallets at alpha=0.05; FDR is what
    # stops the cohort from being mostly luck.
    require_fdr_survivor: bool = True
    min_edge_lcb: float = 0.0
    min_effective_events: float = 20.0
    max_profit_concentration: float = 0.5

    # Copyability. A veto, never averaged into skill.
    min_copyability: float = 0.50
    min_copyable_fraction: float = 0.50
    # Below this many priced entries we have not measured copyability,
    # and unmeasured is not a pass.
    min_copyability_measured: int = 20

    # Scope.
    require_non_sports: bool = True
    max_sports_share: float = 0.25

    # Bounded sets.
    max_cohort: int = 1000
    max_feeder: int = 150

    # Ranking weights. Used ONLY to order already-eligible wallets.
    w_skill: float = 0.55
    w_copyability: float = 0.30
    w_confidence: float = 0.15

    def payload(self) -> dict[str, Any]:
        d = asdict(self)
        d["min_traded_notional"] = format(self.min_traded_notional, "f")
        return d

    def policy_hash(self) -> str:
        return hashlib.sha256(
            json.dumps(self.payload(), sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True)
class WalletFacts:
    """Everything eligibility needs about one wallet, already gathered."""

    wallet: str
    n_active_days: int
    n_closed_markets: int
    traded_notional: Decimal
    # Share of the wallet's activity in markets classified as sports.
    # None = we could not classify enough of it, which fails the scope
    # gate rather than passing it.
    sports_share: float | None
    score: WalletScore | None
    copyability: CopyabilityScore | None


@dataclass
class CohortDecision:
    wallet: str
    status: str
    checks: dict[str, bool]
    reason: str | None
    rank_score: float | None
    skill_score: float | None
    copyability: float | None
    cluster_key: str | None = None
    rank: int | None = None
    facts: dict[str, Any] = field(default_factory=dict)

    @property
    def eligible(self) -> bool:
        return all(self.checks.values())


def _first_failure(checks: dict[str, bool]) -> str | None:
    for name, ok in checks.items():
        if not ok:
            return name
    return None


def evaluate(facts: WalletFacts, policy: CohortPolicy) -> CohortDecision:
    """Apply every veto to one wallet.

    Check order is presentation order, not short-circuit order: all gates
    are evaluated so the operator sees the full picture rather than only
    the first failure. `reason` names the first failing gate for triage.
    """

    score = facts.score
    cop = facts.copyability

    checks: dict[str, bool] = {
        # ── Sample sufficiency ────────────────────────────────────────
        "active_days": facts.n_active_days >= policy.min_active_days,
        "closed_markets": facts.n_closed_markets >= policy.min_closed_markets,
        "traded_notional": facts.traded_notional >= policy.min_traded_notional,
        # ── Skill, statistically ──────────────────────────────────────
        "has_score": score is not None,
        "effective_events": (
            score is not None and (score.n_effective_events or 0.0) >= policy.min_effective_events
        ),
        "edge_lcb_positive": (
            score is not None
            and score.edge_lcb is not None
            and score.edge_lcb > policy.min_edge_lcb
        ),
        "fdr_survivor": (
            (not policy.require_fdr_survivor)
            or (score is not None and bool(score.rationale.get("fdr_survivor")))
        ),
        "concentration_ok": (
            score is not None
            and (
                score.profit_concentration is None
                or score.profit_concentration <= policy.max_profit_concentration
            )
        ),
        # ── Copyability: a veto in its own right ──────────────────────
        # A wallet with a real edge in markets we cannot enter near its
        # price is not a source, it is a spectator sport.
        "copyability_measured": (
            cop is not None and cop.n_measured >= policy.min_copyability_measured
        ),
        "copyable_fraction": (
            cop is not None
            and cop.copyable_fraction is not None
            and cop.copyable_fraction >= policy.min_copyable_fraction
        ),
        "copyability_score": (
            cop is not None
            and cop.copyability is not None
            and cop.copyability >= policy.min_copyability
        ),
        # ── Scope ─────────────────────────────────────────────────────
        # `sports_share is None` fails: we cannot assert a wallet trades
        # non-sports from an unclassified history.
        "non_sports": (
            (not policy.require_non_sports)
            or (facts.sports_share is not None and facts.sports_share <= policy.max_sports_share)
        ),
    }

    rank_score = None
    if score is not None:
        skill = score.skill_score
        conf = score.confidence_score
        copy_component = cop.copyability if cop is not None else None
        if skill is not None and copy_component is not None:
            rank_score = (
                policy.w_skill * skill
                + policy.w_copyability * copy_component
                + policy.w_confidence * (conf or 0.0)
            )

    failure = _first_failure(checks)
    return CohortDecision(
        wallet=facts.wallet,
        status=STATUS_COHORT if failure is None else STATUS_EXCLUDED,
        checks=checks,
        reason=failure,
        rank_score=rank_score,
        skill_score=score.skill_score if score else None,
        copyability=cop.copyability if cop else None,
        facts={
            "n_active_days": facts.n_active_days,
            "n_closed_markets": facts.n_closed_markets,
            "traded_notional": format(facts.traded_notional, "f"),
            "sports_share": facts.sports_share,
            "n_copyability_measured": cop.n_measured if cop else 0,
        },
    )


def select(
    all_facts: list[WalletFacts],
    policy: CohortPolicy,
    clusters: dict[str, str] | None = None,
) -> list[CohortDecision]:
    """Evaluate everyone, then promote a bounded feeder set.

    Returns a decision for EVERY wallet, including exclusions. An
    excluded wallet with a named reason is far more useful than an
    absence, both for the console and for noticing that a gate is set
    wrong (if 900 of 1,000 wallets fail on `copyability_measured`, the
    problem is our quote coverage, not the wallets).
    """

    cluster_of = clusters or {}
    decisions = [evaluate(f, policy) for f in all_facts]
    for d in decisions:
        d.cluster_key = cluster_of.get(d.wallet, d.wallet)

    eligible = [d for d in decisions if d.eligible and d.rank_score is not None]
    eligible.sort(key=lambda d: (-(d.rank_score or 0.0), d.wallet))

    # Cohort membership: the best `max_cohort`. Beyond that a wallet is
    # eligible but untracked, which is a capacity decision, not a
    # judgement — so it stays `cohort`-eligible in `checks` and simply
    # does not get a rank.
    seen_clusters: set[str] = set()
    feeder_count = 0
    for i, d in enumerate(eligible):
        if i >= policy.max_cohort:
            break
        d.status = STATUS_COHORT
        d.rank = i + 1

        # One slot per cluster: a cluster is one opinion, so only its
        # best-ranked member can be actively mirrored. The others stay in
        # the cohort (still worth tracking for consensus) but never
        # occupy a second feeder slot.
        key = d.cluster_key or d.wallet
        if key in seen_clusters:
            d.reason = "cluster_slot_taken"
            continue
        if feeder_count >= policy.max_feeder:
            continue
        seen_clusters.add(key)
        d.status = STATUS_FEEDER
        feeder_count += 1

    return decisions


def feeder_wallets(decisions: list[CohortDecision]) -> list[str]:
    return [d.wallet for d in decisions if d.status == STATUS_FEEDER]


def summarize(decisions: list[CohortDecision]) -> dict[str, Any]:
    """Counts plus the exclusion histogram.

    The histogram is the point: it turns "why is the feeder set empty?"
    into a one-line answer.
    """

    by_status: dict[str, int] = {}
    reasons: dict[str, int] = {}
    for d in decisions:
        by_status[d.status] = by_status.get(d.status, 0) + 1
        if d.status == STATUS_EXCLUDED and d.reason:
            reasons[d.reason] = reasons.get(d.reason, 0) + 1
    return {
        "total": len(decisions),
        "by_status": by_status,
        "exclusion_reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
    }


def policy_record(policy: CohortPolicy, as_of: datetime) -> dict[str, Any]:
    """The row `scoring_policies` stores for this policy."""

    return {
        "version": policy.version,
        "policy_hash": policy.policy_hash(),
        "params": policy.payload(),
        "created_at": as_of,
    }
