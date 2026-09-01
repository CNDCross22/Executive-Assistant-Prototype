-- Fix hermes_prune: proactive_runs has no started_at column.
--
-- 0014 referenced proactive_runs.started_at, which does not exist — the column
-- recording when a scan happened is scanned_at (see 0011). plpgsql resolves
-- column names at execution rather than creation, so the function was created
-- happily and failed only when first run.
--
-- The failure mode was worse than a missing delete. A function call is a
-- single statement, so the error rolled back every delete that had already
-- succeeded inside it: retention appeared to be configured and scheduled while
-- actually removing nothing at all, indefinitely.
--
-- Only that one reference changes. Every other column in the function was
-- verified against information_schema before this was written.

create or replace function hermes_prune(
  audit_days        integer default 90,
  usage_days        integer default 400,
  session_days      integer default 30,
  proactive_days    integer default 60,
  conversation_days integer default null
)
returns table (table_name text, rows_deleted bigint)
language plpgsql
as $$
declare
  deleted bigint;
begin
  if audit_days is not null then
    delete from audit_events where created_at < now() - make_interval(days => audit_days);
    get diagnostics deleted = row_count;
    table_name := 'audit_events'; rows_deleted := deleted; return next;
  end if;

  if usage_days is not null then
    delete from ai_usage where created_at < now() - make_interval(days => usage_days);
    get diagnostics deleted = row_count;
    table_name := 'ai_usage'; rows_deleted := deleted; return next;
  end if;

  -- Only sessions that are already dead. An active session is never pruned,
  -- whatever its age, so this can never sign the Director out mid-task.
  if session_days is not null then
    delete from sessions
    where (expires_at < now() - make_interval(days => session_days))
       or (revoked_at is not null and revoked_at < now() - make_interval(days => session_days));
    get diagnostics deleted = row_count;
    table_name := 'sessions'; rows_deleted := deleted; return next;
  end if;

  if proactive_days is not null then
    delete from proactive_notifications where created_at < now() - make_interval(days => proactive_days);
    get diagnostics deleted = row_count;
    table_name := 'proactive_notifications'; rows_deleted := deleted; return next;

    -- Events are deleted after notifications so a surviving notification can
    -- never be left pointing at an event that no longer exists.
    delete from proactive_events where created_at < now() - make_interval(days => proactive_days);
    get diagnostics deleted = row_count;
    table_name := 'proactive_events'; rows_deleted := deleted; return next;

    -- scanned_at, not started_at. This is the line 0014 got wrong.
    delete from proactive_runs where scanned_at < now() - make_interval(days => proactive_days);
    get diagnostics deleted = row_count;
    table_name := 'proactive_runs'; rows_deleted := deleted; return next;
  end if;

  -- Off by default. Supplying a window here deletes the Director's own
  -- messages, so it must be a deliberate, explicit act every time.
  if conversation_days is not null then
    delete from conversation_messages
    where created_at < now() - make_interval(days => conversation_days);
    get diagnostics deleted = row_count;
    table_name := 'conversation_messages'; rows_deleted := deleted; return next;
  end if;
end;
$$;

comment on function hermes_prune is
  'Deletes rows past their retention window and returns per-table counts. Conversation history is excluded unless a window is passed explicitly.';
