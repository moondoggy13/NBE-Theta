-- NB&E Triangle — Macro indicators + Claude analysis history
-- Depends on: 001_initial_schema.sql

-- ──────────────────────────────────────────────────────────────────────
-- Macro indicators from FRED API (cached daily)
-- ──────────────────────────────────────────────────────────────────────
create table macro_indicators (
  id          uuid primary key default gen_random_uuid(),
  series_id   text not null,
  label       text not null,
  value       numeric(12,4) not null,
  previous    numeric(12,4),
  change_pct  numeric(8,4),
  fetched_at  timestamptz not null default now(),
  run_date    date not null default current_date,
  unique (series_id, run_date)
);

-- ──────────────────────────────────────────────────────────────────────
-- Claude analysis history (stores all Claude responses for learning)
-- ──────────────────────────────────────────────────────────────────────
create table claude_analyses (
  id           uuid primary key default gen_random_uuid(),
  run_date     date not null,
  stage        text not null,
  ticker       text,
  prompt_hash  text not null,
  response     jsonb not null,
  model        text not null,
  tokens_used  integer,
  created_at   timestamptz not null default now(),
  constraint claude_analyses_stage_check
    check (stage in ('premarket','synthesis','regime','eod'))
);
create index claude_analyses_run_date_idx on claude_analyses(run_date, stage);

-- Add Claude confidence modifier to signal_scores
alter table signal_scores add column claude_confidence smallint not null default 0;
alter table signal_scores add column claude_thesis text;

-- Expand signal_events layer check to include macro + claude
alter table signal_events drop constraint signal_events_layer_check;
alter table signal_events add constraint signal_events_layer_check
  check (layer in ('catalyst','technical','options_flow','sentiment','economic','macro','claude'));

-- Enable realtime on macro_indicators
alter publication supabase_realtime add table macro_indicators;
