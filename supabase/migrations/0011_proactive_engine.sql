-- Phase 5: controlled proactive events and in-app notifications.
-- Microsoft 365 remains the source of truth. These rows are assistant state,
-- evidence metadata and delivery receipts; no external action is authorised here.

create table if not exists proactive_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_type text not null check (event_type in ('security_warning','email_attention','overdue_reply','overdue_follow_up','calendar_conflict','upcoming_meeting')),
  enabled boolean not null default true,
  outcome text not null check (outcome in ('notify','recommend')),
  minimum_severity text not null check (minimum_severity in ('low','normal','high','critical')),
  quiet_start text check (quiet_start is null or quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end text check (quiet_end is null or quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text not null,
  cooldown_minutes integer not null check (cooldown_minutes between 5 and 43200),
  daily_cap integer not null check (daily_cap between 1 and 50),
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id,event_type)
);

create table if not exists proactive_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_type text not null check (event_type in ('security_warning','email_attention','overdue_reply','overdue_follow_up','calendar_conflict','upcoming_meeting')),
  dedupe_key text not null,
  source_version text not null,
  source_ref text not null,
  severity text not null check (severity in ('low','normal','high','critical')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  title text not null check (length(title) <= 200),
  summary text not null check (length(summary) <= 500),
  recommendation text check (length(recommendation) <= 500),
  evidence text[] not null default '{}',
  action_link text,
  effective_at timestamptz,
  expires_at timestamptz not null,
  status text not null check (status in ('observed','active','resolved','expired')),
  policy_decision text not null check (policy_decision in ('observe','notify','recommend','disabled','below_threshold','quiet_hours','daily_cap')),
  first_detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id,dedupe_key)
);

create index if not exists proactive_events_active_idx on proactive_events (user_id,status,severity,last_seen_at desc);
create index if not exists proactive_events_expiry_idx on proactive_events (expires_at) where status in ('observed','active');

create table if not exists proactive_notifications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references proactive_events(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  source_version text not null,
  channel text not null default 'in_app' check (channel='in_app'),
  status text not null default 'unread' check (status in ('unread','read','dismissed','snoozed')),
  outcome text not null check (outcome in ('notify','recommend')),
  local_day date not null,
  shown_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  snoozed_until timestamptz,
  last_notified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id,channel)
);

create index if not exists proactive_notifications_inbox_idx on proactive_notifications (user_id,status,last_notified_at desc);
create index if not exists proactive_notifications_day_idx on proactive_notifications (user_id,local_day);

create table if not exists proactive_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  scanned_at timestamptz not null,
  status text not null check (status in ('success','degraded','failed')),
  detected_count integer not null default 0,
  notified_count integer not null default 0,
  observed_count integer not null default 0,
  suppressed_count integer not null default 0,
  resolved_count integer not null default 0,
  degraded_sources text[] not null default '{}',
  delivery_mode text not null check (delivery_mode in ('observe','notify')),
  created_at timestamptz not null default now()
);

create index if not exists proactive_runs_user_time_idx on proactive_runs (user_id,scanned_at desc);

do $$
declare t text;
begin
  foreach t in array array['proactive_policies','proactive_events','proactive_notifications'] loop
    execute format(
      'drop trigger if exists %I_touch on %I; create trigger %I_touch before update on %I for each row execute function touch_updated_at();',
      t,t,t,t
    );
  end loop;
end $$;

comment on table proactive_events is 'Read-only observations. Presence of an event never authorises a Microsoft 365 mutation.';
comment on column proactive_events.source_ref is 'Server-side source identifier. Never rendered as an instruction or approval token.';
comment on table proactive_notifications is 'In-app delivery state only. No external notification channel is enabled in Phase 5.';
