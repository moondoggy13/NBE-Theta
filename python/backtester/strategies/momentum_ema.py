"""Mirror of src/lib/signals/strategies/momentum-ema.ts."""
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..indicators import adx, atr, ema


@dataclass
class MomentumEMA:
    fast: int = 9
    slow: int = 21
    adx_period: int = 14
    adx_threshold: float = 20.0
    atr_period: int = 14
    atr_stop_mult: float = 2.0
    reward_mult: float = 2.5
    params: dict[str, Any] = field(default_factory=dict)

    id: str = "momentum-ema"

    @property
    def warmup_bars(self) -> int:
        return max(self.slow + 2, self.adx_period * 2 + 1, self.atr_period + 2)

    def evaluate(self, h, l, c):
        n = len(c)
        ef = ema(c, self.fast)
        es = ema(c, self.slow)
        adx_out = adx(h, l, c, self.adx_period)
        a = atr(h, l, c, self.atr_period)

        side = np.full(n, "null", dtype=object)
        score = np.full(n, np.nan)
        confidence = np.full(n, np.nan)
        stops = np.full(n, np.nan)
        targets = np.full(n, np.nan)

        for i in range(1, n):
            f, s, fp, ax, t = ef[i], es[i], ef[i - 1], adx_out["adx"][i], a[i]
            if any(np.isnan(v) for v in (f, s, fp, ax, t)):
                continue
            diff = f - s
            slope = f - fp
            trend_on = ax >= self.adx_threshold
            if not trend_on:
                side[i] = "flat"
                score[i] = 0.0
                confidence[i] = max(0.0, min(1.0, (self.adx_threshold - ax) / self.adx_threshold))
                continue
            if diff > 0 and slope > 0:
                side[i] = "long"
                stops[i] = c[i] - self.atr_stop_mult * t
                targets[i] = c[i] + self.atr_stop_mult * t * self.reward_mult
                score[i] = np.tanh(diff / c[i] * 50)
                confidence[i] = max(0.0, min(1.0, ax / 50))
            elif diff < 0 and slope < 0:
                side[i] = "short"
                stops[i] = c[i] + self.atr_stop_mult * t
                targets[i] = c[i] - self.atr_stop_mult * t * self.reward_mult
                score[i] = np.tanh(diff / c[i] * 50)
                confidence[i] = max(0.0, min(1.0, ax / 50))
            else:
                side[i] = "flat"
                score[i] = 0.0
                confidence[i] = 0.2

        return {
            "side": side,
            "score": score,
            "confidence": confidence,
            "ema_fast": ef,
            "ema_slow": es,
            "adx": adx_out["adx"],
            "atr": a,
            "stop": stops,
            "target": targets,
        }
