-- Computer-use runtime config, mirrored from the dashboard.
--
-- The agent-host can run on a different machine than this database (or
-- even on a laptop without inbound network). Rather than push config to
-- the host, we let it poll `/api/agent-host/control` which reads these
-- columns. One row (id=1) is the single source of truth.

alter table risk_state
  add column if not exists cu_dry_run boolean not null default true,
  add column if not exists cu_require_confirm boolean not null default true,
  add column if not exists cu_max_notional_usd numeric not null default 50,
  add column if not exists cu_driver text not null default 'claude'
    check (cu_driver in ('claude', 'openai')),
  add column if not exists cu_host_last_seen timestamptz;
