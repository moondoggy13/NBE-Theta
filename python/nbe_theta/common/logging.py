"""Structured JSON logging.

Mirrors the pino field conventions used on the TS side (``ts``,
``level``, ``component``, ``msg``) so logs from both stacks aggregate
cleanly.
"""

from __future__ import annotations

import logging

import structlog


def configure_logging(level: str = "info") -> None:
    """Configure structlog to emit one JSON object per line."""

    numeric = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(format="%(message)s", level=numeric)
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(numeric),
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", key="ts"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.EventRenamer("msg"),
            structlog.processors.JSONRenderer(),
        ],
        cache_logger_on_first_use=True,
    )


def get_logger(component: str) -> structlog.stdlib.BoundLogger:
    """A logger bound to a component name (the pino ``component`` field)."""

    logger: structlog.stdlib.BoundLogger = structlog.get_logger(component=component)
    return logger
