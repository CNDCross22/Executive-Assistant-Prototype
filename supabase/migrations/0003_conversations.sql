-- =============================================================================
-- Conversations and messages
--
-- Conversation history was held in server memory and lost on every restart.
-- This makes it durable, so she can come back to a thread days later.
--
-- Note what is NOT stored: no email bodies, no Microsoft content. Only what
-- was said in the conversation, plus a record of which tools ran.
-- =============================================================================

create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  title           text not null default 'New conversation',
  /** Set when she archives it; archived threads stay retrievable. */
  archived_at     timestamptz,
  pinned          boolean not null default false,
  message_count   integer not null default 0,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists conversations_user_recent_idx
  on conversations (user_id, last_message_at desc)
  where archived_at is null;

create table if not exists conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  /** What ran to produce this: [{tool, summary, status}]. */
  steps           jsonb not null default '[]'::jsonb,
  /** 'direct' when answered deterministically with no model call. */
  model           text,
  duration_ms     integer,
  /** True when a guard replaced the model's reply. */
  was_blocked     boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists conversation_messages_thread_idx
  on conversation_messages (conversation_id, created_at);

-- Keep the parent row current without a round trip from the application.
create or replace function bump_conversation() returns trigger
language plpgsql as $$
begin
  update conversations
     set last_message_at = new.created_at,
         message_count   = message_count + 1,
         updated_at      = now()
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists conversation_messages_bump on conversation_messages;
create trigger conversation_messages_bump
  after insert on conversation_messages
  for each row execute function bump_conversation();

drop trigger if exists conversations_touch on conversations;
create trigger conversations_touch before update on conversations
  for each row execute function touch_updated_at();
