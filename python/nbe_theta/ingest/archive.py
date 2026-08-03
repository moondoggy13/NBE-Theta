"""Raw-response archive.

Every Gamma page is written verbatim before parsing, so the pipeline is
replayable: re-parse the archived bytes with a newer parser version and
you reproduce (or improve) the normalized rows. ``FsArchive`` writes the
local filesystem now; an R2/S3 archive slots in behind the same ABC
later. ``InMemoryArchive`` backs unit tests.
"""

from __future__ import annotations

import hashlib
import uuid
from abc import ABC, abstractmethod
from pathlib import Path


class Archive(ABC):
    @abstractmethod
    def persist(self, run_id: uuid.UUID, offset: int, raw_bytes: bytes) -> tuple[str, str]:
        """Store bytes; return (uri, sha256_hex)."""


class FsArchive(Archive):
    def __init__(self, base_dir: str) -> None:
        self._base = Path(base_dir)

    def persist(self, run_id: uuid.UUID, offset: int, raw_bytes: bytes) -> tuple[str, str]:
        sha = hashlib.sha256(raw_bytes).hexdigest()
        out_dir = self._base / "gamma" / "events" / str(run_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"offset-{offset:08d}.json"
        path.write_bytes(raw_bytes)
        return (path.as_uri(), sha)


class InMemoryArchive(Archive):
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def persist(self, run_id: uuid.UUID, offset: int, raw_bytes: bytes) -> tuple[str, str]:
        sha = hashlib.sha256(raw_bytes).hexdigest()
        uri = f"mem://gamma/events/{run_id}/offset-{offset}"
        self.objects[uri] = raw_bytes
        return (uri, sha)
