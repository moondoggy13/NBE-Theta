"""Postgres access via psycopg 3.

Thin helpers over a single connection. The worker connects with the
same ``DATABASE_URL`` the migrate runner uses; on Supabase this is the
service-role/superuser connection that bypasses RLS (the worker is
trusted server-side code, never the browser).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import psycopg


@contextmanager
def connect(database_url: str) -> Iterator[psycopg.Connection]:
    """Open a connection, closing it on exit.

    Autocommit is OFF; callers use ``transaction`` for atomic units of
    work. This matches the outbox/ingest pattern where a page of rows
    must commit together (or not at all).
    """

    conn = psycopg.connect(database_url, autocommit=False)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction(conn: psycopg.Connection) -> Iterator[psycopg.Cursor]:
    """Run a block inside one transaction; commit on success, rollback on error."""

    with conn.transaction():
        with conn.cursor() as cur:
            yield cur
