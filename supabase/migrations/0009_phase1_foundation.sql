-- =============================================================================
-- Phase 1 model policy and cost attribution
--
-- Additive metadata only. Existing usage rows remain valid and the global
-- monthly budget continues to work while the application is rolled out.
-- =============================================================================

alter table ai_usage
  add column if not exists budget_category text,
  add column if not exists request_id text,
  add column if not exists conversation_id uuid references conversations(id) on delete set null,
  add column if not exists workflow_id text,
  add column if not exists model_role text,
  add column if not exists response_mode text,
  add column if not exists iteration smallint;

create index if not exists ai_usage_request_idx
  on ai_usage (request_id) where request_id is not null;

create index if not exists ai_usage_workflow_idx
  on ai_usage (workflow_id) where workflow_id is not null;

create index if not exists ai_usage_category_time_idx
  on ai_usage (budget_category, created_at desc) where budget_category is not null;

create index if not exists ai_usage_conversation_time_idx
  on ai_usage (conversation_id, created_at desc) where conversation_id is not null;

comment on column ai_usage.budget_category is
  'interactive, briefing, or background. Used for independent model-spend protection.';
comment on column ai_usage.workflow_id is
  'Correlates every model iteration belonging to one assistant or briefing workflow.';
comment on column ai_usage.response_mode is
  'Internal presentation policy. Never shown to the Director as implementation terminology.';
