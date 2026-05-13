-- Add execution provider selection + agent action audit trail.
--
-- The dashboard's Settings tab now exposes "Execution Venue" (coinbase,
-- computer-use, mock). The worker reads it on each decision cycle. Default
-- stays "coinbase" so existing deployments do not change behavior.
--
-- agent_actions captures every skill the computer-use driver invokes —
-- one row per click/read — so a mis-trade can be reconstructed from
-- screenshots + reasoning even after the LLM context is gone.

alter table risk_state
  add column if not exists execution_provider text
    not null default 'coinbase'
    check (execution_provider in ('coinbase', 'computer-use', 'mock'));

alter table risk_state
  add column if not exists computer_use_host_status jsonb;

create table if not exists agent_actions (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  task_id      text,
  client_order_id text,
  skill        text not null,
  args         jsonb,
  reasoning    text,
  screenshot_url text,
  result       jsonb
);

create index if not exists agent_actions_ts_idx on agent_actions (ts desc);
create index if not exists agent_actions_order_idx on agent_actions (client_order_id);

alter publication supabase_realtime add table agent_actions;
