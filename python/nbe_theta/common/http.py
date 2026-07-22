"""HTTP fetch seam.

The ingest layer depends on the ``Fetcher`` protocol, NOT on httpx
directly. Production wires ``HttpxFetcher``; tests inject a
fixture-backed fetcher so no unit test ever hits a venue API (AGENTS.md
rule). ``get_page`` returns the parsed JSON plus the raw bytes, because
the raw bytes are what we archive for deterministic replay.
"""

from __future__ import annotations

from typing import Any, Protocol

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


class Fetcher(Protocol):
    """Fetches one JSON page, returning (parsed_json, raw_bytes)."""

    def get_page(self, path: str, params: dict[str, Any]) -> tuple[Any, bytes]: ...


_RETRYABLE = (httpx.TransportError, httpx.HTTPStatusError)


class HttpxFetcher:
    """Real fetcher: httpx with bounded exponential-backoff retries on
    transient failures (5xx, timeouts, resets). 4xx (except 429) is NOT
    retried — it's a request bug, not a blip."""

    def __init__(self, base_url: str, timeout_s: float, ca_bundle: str | None = None) -> None:
        verify: str | bool = ca_bundle if ca_bundle else True
        self._client = httpx.Client(base_url=base_url, timeout=timeout_s, verify=verify)

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=0.5, max=8),
        reraise=True,
    )
    def get_page(self, path: str, params: dict[str, Any]) -> tuple[Any, bytes]:
        resp = self._client.get(path, params=params)
        # Retry 5xx and 429; surface 4xx immediately.
        if resp.status_code >= 500 or resp.status_code == 429:
            resp.raise_for_status()
        resp.raise_for_status()
        return resp.json(), resp.content

    def close(self) -> None:
        self._client.close()
