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

    # Where raw API responses are archived (local FS now, R2/S3 later).
    raw_archive_dir: str = Field(default="./data/raw", alias="RAW_ARCHIVE_DIR")

    # TLS: the agent proxy re-terminates TLS, so httpx must trust the
    # bundle. Unset in normal deployments.
    ca_bundle: str | None = Field(default=None, alias="REQUESTS_CA_BUNDLE")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton."""

    return Settings()
