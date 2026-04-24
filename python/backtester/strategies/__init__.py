from .mean_reversion_bb import MeanReversionBB
from .momentum_ema import MomentumEMA

REGISTRY = {
    "mean-reversion-bb": MeanReversionBB,
    "momentum-ema": MomentumEMA,
}
