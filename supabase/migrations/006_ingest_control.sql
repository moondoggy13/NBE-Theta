-- ────────────────────────────────────────────────────────────────────────────
-- PR 2 / 006 — Ingest control plane
--
-- Additive. Bookkeeping for every data-collection job: run history,
-- resumable cursors, and a manifest of raw archived objects (Parquet /
-- JSONL on local FS now, R2/S3 later). The raw bytes live off-database;
-- raw_objects is only the pointer + hash + parser version.
--
-- Security: ingest_runs and raw_objects power the Data Quality tab →
-- anon-read. ingest_cursors is operational internals → deny (anon gets
-- nothing; the worker uses service_role).
--
-- -- Down: drop table raw_objects, ingest_cursors, ingest_runs cascade;
-- ────────────────────────────────────────────────────────────────────────────

-- One row per ingestion job execution.
create table if not exists ingest_runs (
  id            uuid        primary key default gen_random_uuid(),
  source        text        not null,          -- 'gamma' | 'data-api' | 'clob' | 'chain'
  job_type      text        not null,          -- 'registry' | 'wallet-backfill' | ...
  status        text        not null check (status in ('running', 'completed', 'failed')),
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  cursor_before text,
  cursor_after  text,
  rows_read     bigint      not null default 0,
  rows_written  bigint      not null default 0,
  error         text
);
create index if not exists ingest_runs_source_idx on ingest_runs (source, started_at desc);
create index if not exists ingest_runs_status_idx on ingest_runs (status, started_at desc);

-- Resumable cursors, one per (source, stream). A job restart reads the
-- last cursor and continues — the property that guarantees zero
-- duplicates across kill/restart (PR 4 verification).
create table if not exists ingest_cursors (
  source     text        not null,
  stream_key text        not null,
  cursor     text        not null,
  updated_at timestamptz not null default now(),
  primary key (source, stream_key)
);

-- Manifest of archived raw responses. Enables deterministic replay:
-- re-parse object_uri with parser_version and you reproduce the
-- normalized rows.
create table if not exists raw_objects (
  id             uuid        primary key default gen_random_uuid(),
  source         text        not null,
  object_uri     text        not null,
  sha256         text        not null,
  parser_version text        not null,
  captured_at    timestamptz not null default now(),
  window_start   timestamptz,
  window_end     timestamptz,
  row_count      bigint      not null default 0
);
create index if not exists raw_objects_source_idx on raw_objects (source, captured_at desc);
create unique index if not exists raw_objects_sha_idx on raw_objects (sha256);

-- RLS. anon-read the two data-quality tables; deny ingest_cursors.
do $$
declare
  t text;
  anon_tables text[] := array['ingest_runs', 'raw_objects'];
  deny_tables text[] := array['ingest_cursors'];
begin
  foreach t in array anon_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('grant select on %I to anon', t);
    execute format(
      'drop policy if exists "anon read %1$s" on %1$I; '
      || 'create policy "anon read %1$s" on %1$I for select to anon using (true);',
      t
    );
  end loop;
  foreach t in array deny_tables loop
    -- RLS on, no policy → anon denied. service_role bypasses.
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "anon read %1$s" on %1$I', t);
    -- Explicit privilege revoke, not just "no grant": supabase/postgres
    -- sets ALTER DEFAULT PRIVILEGES so tables created by supabase_admin
    -- are auto-granted to anon/authenticated. Without this revoke the
    -- deny-list tables would be anon-readable on any Supabase deployment.
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
