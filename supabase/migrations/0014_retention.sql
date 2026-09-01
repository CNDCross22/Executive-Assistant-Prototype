-- Retention.
--
-- Nothing in this database was ever pruned. Telemetry writes a row to
-- audit_events for every model call, tool call and approval transition, so the
-- table with the highest write rate was also the one with no ceiling.
--
-- Windows are conservative and chosen per table rather than globally:
--   audit_events          90 days   operational forensics, not a record of work
--   ai_usage             400 days   spans a full billing year plus comparison
--   sessions              30 days   past expiry or revocation only
--   proactive_*           60 days   in-app notices are worthless once stale
--   conversation_messages disabled  the Director's own words; never on a timer
--
-- The Director's conversations and approved memory are deliberately NOT on a
-- retention clock. Deleting somebody's history to save disk is a product
-- decision, not a maintenance one, and it is not made here.

create index if not exists audit_events_created_idx
  on audit_events (created_at);

create index if not exists proactive_events_created_idx
  on proactive_events (created_at);

create index if not exists proactive_notifications_created_idx
  on proactive_notifications (created_at);

-- ------------------------------------------------------------------ prune ---

/**
 * Delete rows past their retention window and report exactly what went.
 *
 * Every window is a parameter with a safe default so an operator can widen one
 * for an investigation without editing and redeploying a function. Passing
 * null for a window skips that table entirely rather than deleting everything,
 * because the failure mode of a misread argument must never be data loss.
 */
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

    delete from proactive_runs where started_at < now() - make_interval(days => proactive_days);
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
