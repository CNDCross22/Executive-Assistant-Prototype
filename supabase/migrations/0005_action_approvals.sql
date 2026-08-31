create table if not exists action_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  tool_name text not null,
  arguments jsonb not null,
  preview jsonb not null,
  risk_level smallint not null check (risk_level between 1 and 3),
  status text not null default 'pending' check (status in ('pending', 'executing', 'rejected', 'executed', 'failed', 'expired')),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  decided_at timestamptz,
  result_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists action_approvals_pending_idx on action_approvals (user_id, created_at desc)
  where status = 'pending';

drop trigger if exists action_approvals_touch on action_approvals;
create trigger action_approvals_touch before update on action_approvals
  for each row execute function touch_updated_at();
