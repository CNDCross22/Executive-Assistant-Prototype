-- =============================================================================
-- AI usage and spend tracking
--
-- Every model call is recorded with its token counts and computed cost, so the
-- monthly bill is known rather than discovered. The budget guard reads from
-- this table before allowing a request.
-- =============================================================================

create table if not exists ai_usage (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references users(id) on delete set null,
  provider          text        not null,
  model             text        not null,
  /** What the call was for: 'chat', 'triage', 'briefing'. */
  purpose           text        not null default 'chat',
  prompt_tokens     integer     not null default 0,
  cached_tokens     integer     not null default 0,
  completion_tokens integer     not null default 0,
  /** Micro-dollars, so no floating point drift in the running total. */
  cost_micros       bigint      not null default 0,
  duration_ms       integer,
  created_at        timestamptz not null default now()
);

create index if not exists ai_usage_time_idx  on ai_usage (created_at desc);
create index if not exists ai_usage_user_idx  on ai_usage (user_id, created_at desc);

-- Spend for the current calendar month, in micro-dollars.
create or replace function ai_spend_this_month() returns bigint
language sql stable as $$
  select coalesce(sum(cost_micros), 0)::bigint
  from ai_usage
  where created_at >= date_trunc('month', now());
$$;

comment on table ai_usage is
  'One row per model call. cost_micros is USD * 1,000,000 to keep the running total exact.';
