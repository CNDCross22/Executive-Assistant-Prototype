-- Real-time mail.
--
-- Until now new mail was discovered by a 45-second dashboard poll that only
-- ran while a browser tab was open, plus a background poller that is off by
-- default and cannot run at all in the request-driven Edge runtime.
--
-- These two tables carry the state a push-based path needs: the Microsoft
-- Graph subscriptions we hold, and a delta cursor per mailbox folder so a
-- missed notification can be reconciled without re-reading the whole mailbox.
--
-- Nothing here stores mail. A notification carries an id and a change type;
-- the message itself is fetched with the user's own delegated token, scored by
-- the existing deterministic triage, and never sent to a model on this path.

-- ---------------------------------------------------- graph subscriptions ---

create table if not exists graph_subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid        not null references users(id) on delete cascade,
  -- Microsoft's subscription id, used to renew and to match an incoming notice.
  subscription_id     text        not null unique,
  resource            text        not null,
  change_type         text        not null default 'created',
  -- Only the hash. Graph echoes clientState back in plaintext on every
  -- notification, so we compare hashes and never hold the shared secret.
  client_state_hash   text        not null,
  notification_url    text        not null,
  expires_at          timestamptz not null,
  status              text        not null default 'active'
                        check (status in ('active', 'expired', 'revoked', 'failed')),
  last_notified_at    timestamptz,
  last_renewed_at     timestamptz,
  renewal_failures    integer     not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One live subscription per user per resource. A duplicate would double every
-- notification and double the work each one triggers.
create unique index if not exists graph_subscriptions_user_resource_key
  on graph_subscriptions (user_id, resource) where status = 'active';

create index if not exists graph_subscriptions_expiry_idx
  on graph_subscriptions (expires_at) where status = 'active';

comment on table graph_subscriptions is
  'Microsoft Graph change-notification subscriptions held per user. Stores a hash of clientState, never the secret.';

-- --------------------------------------------------------- delta cursors ---

create table if not exists mail_delta_cursors (
  user_id         uuid        not null references users(id) on delete cascade,
  folder          text        not null default 'inbox',
  -- Opaque Graph continuation URL. Treated as a cursor and never parsed.
  delta_link      text,
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, folder)
);

comment on table mail_delta_cursors is
  'Per-folder Graph delta continuation links, so reconciliation reads only what changed.';

-- ------------------------------------------------------------- triggers ---

do $$
declare t text;
begin
  foreach t in array array['graph_subscriptions', 'mail_delta_cursors'] loop
    execute format(
      'drop trigger if exists %I_touch on %I; '
      'create trigger %I_touch before update on %I '
      'for each row execute function touch_updated_at();',
      t, t, t, t
    );
  end loop;
end $$;
