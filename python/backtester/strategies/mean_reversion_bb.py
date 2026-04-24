"""Mirror of src/lib/signals/strategies/mean-reversion-bb.ts."""
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..indicators import atr, bollinger, sma, stddev


@dataclass
class MeanReversionBB:
    bb_period: int = 20
    bb_std: float = 2.0
    atr_period: int = 14
    atr_stop_mult: float = 1.5
    entry_z: float = 2.0
    exit_z: float = 0.25
    params: dict[str, Any] = field(default_factory=dict)

    id: str = "mean-reversion-bb"

    @property
    def warmup_bars(self) -> int:
        return max(self.bb_period, self.atr_period) + 2

    def evaluate(self, h, l, c):
        """Vectorized evaluation: returns a DataFrame-like dict of
        arrays (side, score, confidence, zscore, mid, stop, target) of the
        same length as the inputs, with NaN sides during warmup."""
        n = len(c)
        m = sma(c, self.bb_period)
        s = stddev(c, self.bb_period)
        bb = bollinger(c, self.bb_period, self.bb_std)
        a = atr(h, l, c, self.atr_period)

        with np.errstate(invalid="ignore", divide="ignore"):
            z = np.where(s > 0, (c - m) / s, np.nan)

        side = np.full(n, "null", dtype=object)
        score = np.full(n, np.nan)
        confidence = np.full(n, np.nan)
        stops = np.full(n, np.nan)
        targets = np.full(n, np.nan)

        valid = ~(np.isnan(m) | np.isnan(s) | (s == 0) | np.isnan(a))
        for i in np.where(valid)[0]:
            zi = z[i]
            if abs(zi) < self.exit_z:
                side[i] = "flat"
                score[i] = 0.0
                confidence[i] = min(1.0, 1 - abs(zi) / self.exit_z)
            elif zi <= -self.entry_z:
                side[i] = "long"
                score[i] = max(-1.0, min(1.0, -zi / 3))
                confidence[i] = max(0.0, min(1.0, abs(zi) / (self.entry_z * 1.5)))
                stops[i] = c[i] - self.atr_stop_mult * a[i]
                targets[i] = m[i]
            elif zi >= self.entry_z:
                side[i] = "short"
                score[i] = max(-1.0, min(1.0, -zi / 3))
                confidence[i] = max(0.0, min(1.0, abs(zi) / (self.entry_z * 1.5)))
                stops[i] = c[i] + self.atr_stop_mult * a[i]
                targets[i] = m[i]

        return {
            "side": side,
            "score": score,
            "confidence": confidence,
            "zscore": z,
            "middle": m,
            "upper": bb["upper"],
            "lower": bb["lower"],
            "atr": a,
            "stop": stops,
            "target": targets,
        }
