-- Phase 3: scoped, temporal and auditable memory metadata.
-- Additive except for replacing the overly broad key uniqueness rule.

alter table memory_entries
  add column if not exists scope text not null default 'global',
  add column if not exists scope_ref text,
  add column if not exists last_confirmed_at timestamptz,
  add column if not exists conflict_state text not null default 'none',
  add column if not exists supersedes_id uuid references memory_entries(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memory_entries_scope_check'
  ) then
    alter table memory_entries add constraint memory_entries_scope_check
      check (scope in ('global', 'person', 'project', 'communication', 'calendar', 'email', 'operational'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'memory_entries_conflict_state_check'
  ) then
    alter table memory_entries add constraint memory_entries_conflict_state_check
      check (conflict_state in ('none', 'review'));
  end if;
end $$;

update memory_entries
set scope = case
  when type = 'person' then 'person'
  when type = 'operational' then 'operational'
  else 'global'
end
where scope = 'global';

update memory_entries
set scope_ref = lower(subject)
where scope = 'person' and scope_ref is null and subject is not null;

update memory_entries
set last_confirmed_at = created_at
where last_confirmed_at is null and status = 'active' and source in ('explicit', 'seeded');

drop index if exists memory_key_unique;
create unique index if not exists memory_key_scope_unique
  on memory_entries (user_id, key, scope, coalesce(scope_ref, ''))
  where key is not null and status = 'active';

create index if not exists memory_scope_active_idx
  on memory_entries (user_id, scope, lower(scope_ref), importance desc)
  where status = 'active';

create index if not exists memory_expiry_idx
  on memory_entries (user_id, expires_at)
  where status = 'active' and expires_at is not null;

comment on column memory_entries.scope is
  'Applicability boundary. Specific scopes can override but do not delete broader memories.';
comment on column memory_entries.last_confirmed_at is
  'When the Director explicitly confirmed or approved this memory.';
comment on column memory_entries.conflict_state is
  'review entries are withheld from prompts until resolved.';
