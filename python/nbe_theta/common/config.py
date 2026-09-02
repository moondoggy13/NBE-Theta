"""Environment-driven configuration.

One ``Settings`` object per process, loaded once. Mirrors the TS side's
env conventions (``DATABASE_URL``, ``LOG_LEVEL``) so a single ``.env``
serves both stacks.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Worker settings.

    ``DATABASE_URL`` is required for anything that touches Postgres.
    Everything else has a safe default so ``theta-registry --dry-run``
    can run with no config.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = Field(default="", alias="DATABASE_URL")
    log_level: str = Field(default="info", alias="LOG_LEVEL")

    # Gamma API (Polymarket market registry).
    gamma_base_url: str = Field(default="https://gamma-api.polymarket.com", alias="GAMMA_BASE_URL")
    gamma_page_limit: int = Field(default=100, alias="GAMMA_PAGE_LIMIT", ge=1, le=500)
    # 0 = unbounded (sweep to the end). A positive value bounds one run
    # (useful for a smoke run or the first cut).
    gamma_max_pages: int = Field(default=0, alias="GAMMA_MAX_PAGES", ge=0)
    gamma_timeout_s: float = Field(default=30.0, alias="GAMMA_TIMEOUT_S", gt=0)

    # Data API (Polymarket wallet history + discovery).
    data_api_base_url: str = Field(
        default="https://data-api.polymarket.com", alias="DATA_API_BASE_URL"
    )
    data_api_page_limit: int = Field(default=100, alias="DATA_API_PAGE_LIMIT", ge=1, le=500)
    data_api_timeout_s: float = Field(default=30.0, alias="DATA_API_TIMEOUT_S", gt=0)
    # Minimum seconds between Data API calls (per-source rate-limit budget).
    data_api_min_interval_s: float = Field(default=0.2, alias="DATA_API_MIN_INTERVAL_S", ge=0)

    # Live monitor (theta-live-monitor) cadences.
    monitor_interval_s: float = Field(default=30.0, alias="MONITOR_INTERVAL_S", gt=0)
    sync_overlap_s: float = Field(default=120.0, alias="SYNC_OVERLAP_S", ge=0)
    sync_max_pages: int = Field(default=5, alias="SYNC_MAX_PAGES", ge=1)
    positions_refresh_s: float = Field(default=300.0, alias="POSITIONS_REFRESH_S", gt=0)
    leaderboard_refresh_s: float = Field(default=3600.0, alias="LEADERBOARD_REFRESH_S", gt=0)
    leaderboard_limit: int = Field(default=50, alias="LEADERBOARD_LIMIT", ge=1, le=100)

    # CLOB (Polymarket executable prices + market-data stream).
    clob_base_url: str = Field(default="https://clob.polymarket.com", alias="CLOB_BASE_URL")
    clob_timeout_s: float = Field(default=30.0, alias="CLOB_TIMEOUT_S", gt=0)
    clob_ws_url: str = Field(
        default="wss://ws-subscriptions-clob.polymarket.com/ws/market", alias="CLOB_WS_URL"
    )
    # Market-data collector (theta-market-data).
    market_cycle_s: float = Field(default=15.0, alias="MARKET_CYCLE_S", gt=0)
    market_max_messages: int = Field(default=500, alias="MARKET_MAX_MESSAGES", ge=1)
    # Minimum gap between persisted quotes for one token. A busy book
    # updates far faster than any consumer reads; see CollectorConfig.
    market_min_quote_interval_s: float = Field(
        default=1.0, alias="MARKET_MIN_QUOTE_INTERVAL_S", ge=0
    )
    market_stale_after_s: float = Field(default=120.0, alias="MARKET_STALE_AFTER_S", gt=0)
    # Cap on tokens subscribed in one process. A watchlist that outgrows
    # this needs sharding, and silently truncating would look like
    # coverage we do not have — the collector logs the drop.
    market_max_tokens: int = Field(default=200, alias="MARKET_MAX_TOKENS", ge=1)

    # Where raw API responses are archived (local FS now, R2/S3 later).
    raw_archive_dir: str = Field(default="./data/raw", alias="RAW_ARCHIVE_DIR")

    # TLS: the agent proxy re-terminates TLS, so httpx must trust the
    # bundle. Unset in normal deployments.
    ca_bundle: str | None = Field(default=None, alias="REQUESTS_CA_BUNDLE")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton."""

    return Settings()
