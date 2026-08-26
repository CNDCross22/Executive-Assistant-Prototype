-- =============================================================================
-- Memory, preferences and skills
--
-- What makes the assistant improve rather than merely persist. Three ideas:
--
--   memory_entries   what it knows about her and her working life
--   memory_signals   observations that have not yet earned the right to be memory
--   skills           reusable procedures, editable without a deploy
--
-- Design rule throughout: nothing becomes a durable belief without either an
-- explicit instruction from her, or repeated observation followed by her
-- approval. Silent learning is not permitted.
-- =============================================================================

-- ---------------------------------------------------------------- memory ----

create table if not exists memory_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,

  /**
   * preference    how she wants things done ("no meetings before 9")
   * person        facts about someone ("James is the CFO")
   * working_style how she operates ("prefers short emails")
   * operational   rules for the assistant ("always ask before sending")
   * historical    what happened ("board pack sent 14 Aug")
   * procedural    how to do something ("how she likes her briefing")
   */
  type          text not null check (type in
                  ('preference', 'person', 'working_style', 'operational', 'historical', 'procedural')),

  title         text not null,
  content       text not null,

  /** Machine-readable key for preferences the engine consumes, e.g. 'workday.start'. */
  key           text,
  /** Who or what this is about — usually an email address for type='person'. */
  subject       text,

  importance    smallint not null default 3 check (importance between 1 and 5),
  confidence    numeric(3,2) not null default 1.00 check (confidence between 0 and 1),

  /** explicit = she said so. observed = inferred then approved. seeded = shipped default. */
  source        text not null default 'explicit' check (source in ('explicit', 'observed', 'seeded')),
  source_ref    text,

  /** proposed entries are waiting for her yes or no; only active ones are used. */
  status        text not null default 'active'
                  check (status in ('active', 'proposed', 'dismissed', 'archived')),

  pinned        boolean not null default false,
  use_count     integer not null default 0,
  last_used_at  timestamptz,
  /** Optional expiry for things that stop being true. */
  expires_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists memory_user_active_idx
  on memory_entries (user_id, type, importance desc)
  where status = 'active';

create index if not exists memory_subject_idx on memory_entries (user_id, lower(subject))
  where subject is not null;

create index if not exists memory_proposed_idx on memory_entries (user_id, created_at desc)
  where status = 'proposed';

-- One active entry per structured key, so preferences cannot contradict each other.
create unique index if not exists memory_key_unique
  on memory_entries (user_id, key) where key is not null and status = 'active';

-- Cheap keyword retrieval. Semantic search can be layered on later; this needs
-- no embedding API call and is predictable enough to trust today.
create index if not exists memory_search_idx
  on memory_entries using gin (to_tsvector('english', title || ' ' || content));

comment on table memory_entries is
  'What Hermes knows. Nothing lands here silently: explicit instruction, or observation plus approval.';

-- --------------------------------------------------------------- signals ----
-- Candidate patterns. They accumulate quietly and only become a proposal once
-- seen enough times to be worth interrupting her about.

create table if not exists memory_signals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  /** Stable identity for the pattern, e.g. 'preference:workday.start:09:00'. */
  signal_key     text not null,
  type           text not null,
  title          text not null,
  content        text not null,
  key            text,
  subject        text,
  observed_count integer not null default 1,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  /** Set once it has been raised with her, so she is not asked twice. */
  promoted_at    timestamptz,
  unique (user_id, signal_key)
);

create index if not exists memory_signals_ready_idx
  on memory_signals (user_id, observed_count desc)
  where promoted_at is null;

-- ---------------------------------------------------------------- skills ----
-- Procedures live in code as defaults; rows here add to or override them, so a
-- new way of working does not require a deploy.

create table if not exists skills (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete cascade,
  slug         text not null,
  name         text not null,
  when_to_use  text not null default '',
  /** Lower-case words that select this skill from her message. */
  triggers     text[] not null default '{}',
  /** Tool names this skill needs; empty means all. */
  tools        text[] not null default '{}',
  instructions text not null,
  example      text,
  enabled      boolean not null default true,
  /** Built-in skills are seeded and marked so the UI can explain them. */
  built_in     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, slug)
);

create index if not exists skills_enabled_idx on skills (user_id) where enabled;

-- ------------------------------------------------------------- triggers -----

do $$
declare t text;
begin
  foreach t in array array['memory_entries', 'skills'] loop
    execute format(
      'drop trigger if exists %I_touch on %I; '
      'create trigger %I_touch before update on %I '
      'for each row execute function touch_updated_at();',
      t, t, t, t
    );
  end loop;
end $$;
