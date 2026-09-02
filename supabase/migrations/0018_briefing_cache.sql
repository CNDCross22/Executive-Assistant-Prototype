-- Share the briefing cache across Edge isolates.
--
-- The cache was a Map in the API process. Each Edge isolate holds its own, so
-- the intended twenty-minute reuse mostly missed and briefings were
-- regenerated — and re-billed against the briefing budget — far more often
-- than the design assumed.
--
-- One row per user. The signature is a digest of the deterministic dashboard
-- facts the briefing was written from: when it changes, the briefing is stale
-- regardless of age.
--
-- What is stored is model-written prose about the user's own mail, which is
-- the same class of content already held in conversation_messages. No message
-- bodies, senders or subjects are stored here.

create table if not exists briefing_cache (
  user_id             uuid        primary key references users(id) on delete cascade,
  signature           text        not null,
  text                text        not null,
  unavailable_reason  text,
  generated_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists briefing_cache_generated_idx on briefing_cache (generated_at);

comment on table briefing_cache is
  'Most recent generated briefing per user, keyed by a digest of the facts it was written from.';

do $$
begin
  execute 'drop trigger if exists briefing_cache_touch on briefing_cache';
  execute 'create trigger briefing_cache_touch before update on briefing_cache '
          'for each row execute function touch_updated_at()';
end $$;
