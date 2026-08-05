"""Significance machinery.

Three corrections, each guarding against a specific way this pipeline
would otherwise manufacture false alpha:

1. **Empirical-Bayes prior.** A wallet 4-for-5 is not an 80% forecaster.
   Shrink toward the population's own rate, fitted from the data rather
   than assumed (Beta(1,1) would treat a 5-trade wallet as informative).

2. **Event-block bootstrap.** Ten markets on one election are ~one
   observation, not ten. Resample whole EVENT CLUSTERS, never individual
   episodes — clustering by `condition_id` alone is not enough, since
   several conditions routinely settle off the same real-world fact.

3. **Benjamini–Hochberg FDR.** Testing thousands of wallets at α=0.05
   yields ~5% of them "significant" by construction. BH controls the
   expected false-discovery proportion across the whole universe.

Explicitly NOT here: DSR and PBO. Those evaluate competing *strategy or
model selections*; using them as a per-wallet significance test is a
category error. They belong to model comparison (later).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass


@dataclass(frozen=True)
class BetaPosterior:
    alpha: float
    beta: float

    @property
    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    def lower_credible_bound(self, level: float = 0.05) -> float:
        """Approximate lower bound of the central credible interval.

        Normal approximation on the Beta — adequate for the sample sizes
        that clear our promotion bar, and it degrades conservatively
        (wider) for small n because the variance term grows.
        """

        a, b = self.alpha, self.beta
        n = a + b
        mean = a / n
        var = (a * b) / (n * n * (n + 1))
        sd = math.sqrt(var)
        z = 1.6448536269514722 if level <= 0.05 else 1.2815515655446004
        return max(0.0, mean - z * sd)


def fit_population_prior(rates: list[float], *, strength: float = 20.0) -> tuple[float, float]:
    """Method-of-moments empirical prior from the population's own rates.

    ``strength`` is the prior's weight in pseudo-observations: a wallet
    needs roughly that many episodes before its own record dominates the
    population mean. 20 is deliberately sceptical.
    """

    if not rates:
        return (1.0, 1.0)
    m = sum(rates) / len(rates)
    m = min(max(m, 1e-6), 1 - 1e-6)
    return (m * strength, (1 - m) * strength)


def posterior_accuracy(successes: int, trials: int, prior: tuple[float, float]) -> BetaPosterior:
    a0, b0 = prior
    return BetaPosterior(alpha=a0 + successes, beta=b0 + (trials - successes))


# ── effective sample size ─────────────────────────────────────────


def effective_events(cluster_ids: list[str | None]) -> float:
    """Count of independent observations, not of episodes.

    Episodes sharing an event cluster are correlated; N episodes across
    one cluster contribute ~1, not N. Unclustered episodes (None) are
    treated as independent — the conservative direction would be to
    merge them, but we lack the evidence to, so they count as one each
    and the caller should treat a high None-share as low confidence.
    """

    if not cluster_ids:
        return 0.0
    counts: dict[str, int] = {}
    singles = 0
    for c in cluster_ids:
        if c is None:
            singles += 1
        else:
            counts[c] = counts.get(c, 0) + 1
    # Each cluster contributes sqrt(n) — between 1 (fully redundant) and
    # n (fully independent), a standard compromise for unknown
    # within-cluster correlation.
    clustered = sum(math.sqrt(n) for n in counts.values())
    return clustered + singles


# ── event-block bootstrap ─────────────────────────────────────────


@dataclass(frozen=True)
class BootstrapResult:
    point_estimate: float
    lower: float
    upper: float
    n_resamples: int

    @property
    def excludes_zero(self) -> bool:
        """True when the whole interval sits above zero — the bar for
        claiming a positive edge."""

        return self.lower > 0.0


MIN_CLUSTERS_FOR_BOOTSTRAP = 3


def event_block_bootstrap(
    values: list[float],
    cluster_ids: list[str | None],
    *,
    n_resamples: int = 2000,
    level: float = 0.05,
    seed: int = 12345,
    min_clusters: int = MIN_CLUSTERS_FOR_BOOTSTRAP,
) -> BootstrapResult | None:
    """Percentile bootstrap resampling whole event clusters.

    Resampling individual episodes would treat ten correlated markets as
    ten independent draws and shrink the interval by ~sqrt(10) — the
    single most effective way to fabricate significance in this domain.

    **Refuses to run below ``min_clusters``.** With one block, every
    resample draws that same block and the interval collapses to zero
    width — which would make a wallet whose entire record is a single
    event look *infinitely* certain, the precise false-positive this
    machinery exists to stop. Too few blocks means the honest answer is
    "cannot establish significance", so we return None and let it
    propagate: p = 1.0, no FDR survival, no Tier A. Fail closed.
    """

    if not values or len(values) != len(cluster_ids):
        return None

    blocks: dict[str, list[float]] = {}
    for i, (v, c) in enumerate(zip(values, cluster_ids, strict=True)):
        # Unclustered episodes are their own block; index keeps them
        # distinct even when values collide.
        key = c if c is not None else f"__solo__{i}"
        blocks.setdefault(key, []).append(v)
    keys = list(blocks)
    if len(keys) < min_clusters:
        return None

    point = sum(values) / len(values)
    rng = random.Random(seed)
    means: list[float] = []
    for _ in range(n_resamples):
        drawn: list[float] = []
        for _ in range(len(keys)):
            drawn.extend(blocks[keys[rng.randrange(len(keys))]])
        if drawn:
            means.append(sum(drawn) / len(drawn))
    if not means:
        return None
    means.sort()
    lo_i = int((level / 2) * len(means))
    hi_i = min(len(means) - 1, int((1 - level / 2) * len(means)))
    return BootstrapResult(
        point_estimate=point,
        lower=means[lo_i],
        upper=means[hi_i],
        n_resamples=len(means),
    )


# ── multiple testing ──────────────────────────────────────────────


def benjamini_hochberg(p_values: list[float], q: float = 0.10) -> list[bool]:
    """BH step-up. Returns a survival mask aligned to the input order.

    Controls the expected proportion of false discoveries among the
    wallets we call skilled — the relevant error rate when screening a
    large universe, where per-test α control would admit ~α·N spurious
    "edges".
    """

    n = len(p_values)
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: p_values[i])
    survived = [False] * n
    cutoff_rank = -1
    for rank, idx in enumerate(order, start=1):
        if p_values[idx] <= (rank / n) * q:
            cutoff_rank = rank
    if cutoff_rank > 0:
        for rank, idx in enumerate(order, start=1):
            if rank <= cutoff_rank:
                survived[idx] = True
    return survived


def bh_q_values(p_values: list[float]) -> list[float]:
    """BH-adjusted q-values, enforcing monotonicity."""

    n = len(p_values)
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: p_values[i])
    q = [0.0] * n
    prev = 1.0
    for rank in range(n, 0, -1):
        idx = order[rank - 1]
        val = min(prev, p_values[idx] * n / rank)
        q[idx] = min(1.0, val)
        prev = q[idx]
    return q


def one_sided_p_value(
    bootstrap: BootstrapResult, resample_means: list[float] | None = None
) -> float:
    """Fraction of bootstrap mass at or below zero.

    Derived from the interval when the raw resample distribution isn't
    retained: a conservative approximation via the normal implied by the
    percentile interval.
    """

    if resample_means:
        n_le = sum(1 for m in resample_means if m <= 0.0)
        return max(1.0 / len(resample_means), n_le / len(resample_means))
    # Interval half-width ≈ 1.96σ for a 95% interval.
    half = (bootstrap.upper - bootstrap.lower) / 2.0
    if half <= 0:
        return 0.0 if bootstrap.point_estimate > 0 else 1.0
    sigma = half / 1.959963984540054
    if sigma == 0:
        return 0.0 if bootstrap.point_estimate > 0 else 1.0
    z = bootstrap.point_estimate / sigma
    # Survival function of the standard normal.
    return 0.5 * math.erfc(z / math.sqrt(2.0))
