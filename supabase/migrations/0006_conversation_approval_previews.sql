-- Keep executable approval cards visible after a page refresh or API restart.
alter table conversation_messages
  add column if not exists approval jsonb;

comment on column conversation_messages.approval is
  'Director-facing approval presentation only: {id, preview, expiresAt}. No Graph ids or tool arguments.';
