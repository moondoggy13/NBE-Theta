"""Candidate discovery: cheap seeds → the wallet_candidates queue.

Stage 1 of the four-stage funnel (see the plan). Seeds wallets from
leaderboards, per-market top holders, and large recent trades — each
cheap, none requiring a full history backfill. A materiality filter then
promotes the wallets worth the expensive backfill (PR 4's `run`).

Priority scoring is deliberately simple and interpretable: rank-based
for leaderboards (top of the board scores highest), magnitude-based for
holders/large-trades. It is a triage signal, not a skill score — skill
is measured later (PR 5) from reconstructed history.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from nbe_theta.common.logging import get_logger
from nbe_theta.ingest.dataapi import DataApiClient
from nbe_theta.ingest.ratelimit import RateLimiter
from nbe_theta.ingest.wallet_store import WalletStore

log = get_logger("ingest.candidates")


@dataclass
class SeedConfig:
    leaderboard_windows: tuple[str, ...] = ("WEEK", "MONTH")
    leaderboard_orders: tuple[str, ...] = ("pnl", "volume")
    leaderboard_limit: int = 100
    holder_limit: int = 50
    # Promote a candidate once its best priority across sources clears
    # this bar. Kept low initially — the backfill itself is the next
    # filter, and PR 5's scoring is the real gate.
    promote_threshold: float = 0.25
    promote_max: int = 500


@dataclass
class SeedResult:
    seeded: int
    promoted: int


class CandidateSeeder:
    def __init__(
        self,
        client: DataApiClient,
        store: WalletStore,
        limiter: RateLimiter,
        config: SeedConfig | None = None,
    ) -> None:
        self._client = client
        self._store = store
        self._limiter = limiter
        self._cfg = config or SeedConfig()

    def _now(self) -> datetime:
        return datetime.now(tz=UTC)

    def seed_leaderboards(self) -> int:
        """Seed from each (window, order) board. Priority is rank-based:
        rank 0 → 1.0, decaying linearly to ~0 at the bottom of the board."""

        seeded = 0
        now = self._now()
        for window in self._cfg.leaderboard_windows:
            for order in self._cfg.leaderboard_orders:
                self._limiter.acquire()
                entries = self._client.leaderboard(window, order, self._cfg.leaderboard_limit)
                n = max(1, len(entries))
                for rank, e in enumerate(entries):
                    priority = 1.0 - (rank / n)
                    self._store.upsert_candidate(
                        e.wallet, f"leaderboard:{window}:{order}", priority, now
                    )
                    seeded += 1
                self._store.commit()
        return seeded

    def seed_holders(self, condition_ids: list[str]) -> int:
        """Seed top holders of the given markets (e.g. watchlisted or
        high-liquidity). Priority is the holder's rank within the market."""

        seeded = 0
        now = self._now()
        for cid in condition_ids:
            self._limiter.acquire()
            holders = self._client.holders(cid, self._cfg.holder_limit)
            n = max(1, len(holders))
            for rank, h in enumerate(holders):
                priority = 1.0 - (rank / n)
                self._store.upsert_candidate(h.wallet, "top-holder", priority, now)
                seeded += 1
            self._store.commit()
        return seeded

    def promote(self) -> int:
        """Promote up to ``promote_max`` unpromoted candidates whose best
        priority clears the threshold."""

        now = self._now()
        addresses = self._store.list_promotable(self._cfg.promote_max)
        promoted = 0
        for addr in addresses:
            self._store.promote_candidate(addr, now)
            promoted += 1
        self._store.commit()
        return promoted

    def run(self, condition_ids: list[str] | None = None) -> SeedResult:
        run_id = self._store.start_run("wallet-candidates", None)
        try:
            seeded = self.seed_leaderboards()
            if condition_ids:
                seeded += self.seed_holders(condition_ids)
            promoted = self.promote()
            self._store.finish_run(
                run_id,
                status="completed",
                rows_read=seeded,
                rows_written=seeded,
                cursor_after=None,
                error=None,
            )
            log.info("candidate seed complete", seeded=seeded, promoted=promoted)
            return SeedResult(seeded=seeded, promoted=promoted)
        except Exception as exc:  # noqa: BLE001
            self._store.rollback()
            self._store.finish_run(
                run_id,
                status="failed",
                rows_read=0,
                rows_written=0,
                cursor_after=None,
                error=str(exc),
            )
            log.error("candidate seed failed", error=str(exc))
            raise
