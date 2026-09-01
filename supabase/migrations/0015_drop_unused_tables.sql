-- Remove schema the runtime never used.
--
-- `skills` was created in 0004 to hold reusable procedures editable without a
-- deploy. That never shipped: the working source of truth is the SKILLS array
-- in apps/api/src/agent/skills.ts, and no code has ever read or written the
-- table. `tenants` was created in 0001 to model a second organisation without
-- a rewrite. Hermes is single-tenant by design and locks to one directory at
-- sign-in, so users.tenant_id has only ever been null.
--
-- A dormant table is not free. It invites the next person to assume it is
-- populated, and it makes an honest reading of the schema harder.
--
-- Every drop below is guarded on the table being empty. If anything has been
-- written since this was written, the migration leaves it alone and says so
-- rather than destroying data to satisfy a tidy-up.

do $$
declare
  skill_rows  bigint := 0;
  tenant_rows bigint := 0;
  bound_users bigint := 0;
begin
  if to_regclass('public.skills') is not null then
    execute 'select count(*) from skills' into skill_rows;
    if skill_rows = 0 then
      drop trigger if exists skills_touch on skills;
      drop table skills;
      raise notice 'Dropped unused table: skills';
    else
      raise notice 'Kept skills: % row(s) present. Remove manually once reviewed.', skill_rows;
    end if;
  end if;

  if to_regclass('public.tenants') is not null then
    execute 'select count(*) from tenants' into tenant_rows;
    execute 'select count(*) from users where tenant_id is not null' into bound_users;

    if tenant_rows = 0 and bound_users = 0 then
      -- The column goes first; the foreign key is what pins the table.
      drop index if exists users_tenant_idx;
      alter table users drop column if exists tenant_id;

      drop trigger if exists tenants_touch on tenants;
      drop table tenants;
      raise notice 'Dropped unused table: tenants';
    else
      raise notice 'Kept tenants: % tenant row(s), % bound user(s). Remove manually once reviewed.',
        tenant_rows, bound_users;
    end if;
  end if;
end $$;
