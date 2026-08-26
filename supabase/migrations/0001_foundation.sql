-- =============================================================================
-- Hermes EA — foundation
--
-- Holds ASSISTANT state only. Microsoft 365 remains the source of truth for
-- mail, calendar, contacts and tasks; we store references (ids), never copies.
--
-- Run in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -f supabase/migrations/0001_foundation.sql
-- =============================================================================

create extension if not exists "pgcrypto";

-- --------------------------------------------------------------- tenants ----
-- One row today. Modelled properly so a second is not a rewrite.

create table if not exists tenants (
  id             uuid primary key default gen_random_uuid(),
  ms_tenant_id   text        not null unique,
  name           text        not null,
  primary_domain text,
  settings       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table tenants is 'The Microsoft 365 organisation this assistant serves.';

-- ----------------------------------------------------------------- users ----

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenants(id) on delete cascade,
  ms_user_id    text        not null unique,
  email         text        not null,
  display_name  text        not null,
  job_title     text,
  role          text        not null default 'director'
                  check (role in ('director', 'delegate', 'admin')),
  timezone      text        not null default 'UTC',
  is_active     boolean     not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists users_email_key on users (lower(email));
create index if not exists users_tenant_idx on users (tenant_id);

-- ---------------------------------------------------- oauth connections ----
-- The MSAL token cache (which contains the refresh token) is encrypted with
-- ENCRYPTION_KEY before it ever reaches this table. Tokens never leave the
-- server and are never sent to the browser.

create table if not exists oauth_connections (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  provider                text not null default 'microsoft',
  home_account_id         text,
  scopes                  text[] not null default '{}',
  refresh_token_encrypted text,
  token_cache_encrypted   text,
  status                  text not null default 'connected'
                            check (status in ('connected', 'needs_reauth', 'revoked')),
  last_refreshed_at       timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (user_id, provider)
);

comment on column oauth_connections.token_cache_encrypted is
  'AES-256-GCM encrypted MSAL token cache. Contains the refresh token.';

-- -------------------------------------------------------------- sessions ----
-- Opaque tokens; only the SHA-256 hash is stored, so a database leak does not
-- hand anyone a working session.

create table if not exists sessions (
  id         uuid primary key default gen_random_uuid(),
  token_hash text        not null unique,
  user_id    uuid        not null references users(id) on delete cascade,
  user_agent text,
  ip         inet,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_idx    on sessions (user_id);
create index if not exists sessions_expiry_idx  on sessions (expires_at) where revoked_at is null;

-- --------------------------------------------------------- audit events ----
-- Every assistant action, whether it succeeded or not. Written before the
-- result is known and updated after, so failures cannot go unrecorded.

create table if not exists audit_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id) on delete set null,
  request_id    text,
  actor         text not null default 'assistant'
                  check (actor in ('user', 'assistant', 'system')),
  category      text not null,
  action        text not null,
  resource_type text,
  resource_id   text,
  status        text not null default 'pending'
                  check (status in ('pending', 'success', 'failed', 'cancelled', 'awaiting_approval')),
  risk_level    smallint not null default 0 check (risk_level between 0 and 3),
  detail        jsonb not null default '{}'::jsonb,
  duration_ms   integer,
  created_at    timestamptz not null default now()
);

create index if not exists audit_user_time_idx on audit_events (user_id, created_at desc);
create index if not exists audit_category_idx  on audit_events (category, created_at desc);

-- ------------------------------------------------------------- updated_at ---

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['tenants', 'users', 'oauth_connections'] loop
    execute format(
      'drop trigger if exists %I_touch on %I; '
      'create trigger %I_touch before update on %I '
      'for each row execute function touch_updated_at();',
      t, t, t, t
    );
  end loop;
end $$;
