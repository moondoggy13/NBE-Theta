"""NBE-Theta Python worker.

One package, multiple commands. PR 3 ships the ``ingest`` registry
poller (``theta-registry``); later PRs add ledger, analytics, graph,
signals, and backtest under the same ``nbe_theta`` namespace and the
shared ``common`` module (config, logging, db, http).
"""

__version__ = "0.1.0"
