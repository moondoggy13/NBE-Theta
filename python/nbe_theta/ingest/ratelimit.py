"""Per-source rate-limit budget.

A minimum-interval throttle: ``acquire()`` blocks until at least
``min_interval_s`` has passed since the previous acquire. The clock and
sleep functions are injectable so tests advance time deterministically
without real waits.
"""

from __future__ import annotations

import time
from collections.abc import Callable


class RateLimiter:
    def __init__(
        self,
        min_interval_s: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._min = max(0.0, min_interval_s)
        self._clock = clock
        self._sleep = sleep
        self._last: float | None = None

    def acquire(self) -> None:
        if self._min <= 0:
            return
        now = self._clock()
        if self._last is not None:
            wait = self._min - (now - self._last)
            if wait > 0:
                self._sleep(wait)
                now = self._clock()
        self._last = now
