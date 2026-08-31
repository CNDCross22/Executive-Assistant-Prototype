-- OpenAI Responses API and processing-tier cost attribution.
-- Additive and backward-compatible: older application versions ignore it.

alter table ai_usage
  add column if not exists service_tier text;

create index if not exists ai_usage_service_tier_time_idx
  on ai_usage (service_tier, created_at desc) where service_tier is not null;

comment on column ai_usage.service_tier is
  'Processing tier actually returned by OpenAI, used to audit Fast mode cost attribution.';
