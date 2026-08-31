-- Bind every notification to an event owned by the same user at the database
-- layer, not only in application queries.

do $$
begin
  if not exists (select 1 from pg_constraint where conname='proactive_events_id_user_unique') then
    alter table proactive_events add constraint proactive_events_id_user_unique unique (id,user_id);
  end if;
end $$;

alter table proactive_notifications drop constraint if exists proactive_notifications_event_id_fkey;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='proactive_notifications_event_user_fkey') then
    alter table proactive_notifications add constraint proactive_notifications_event_user_fkey
      foreign key (event_id,user_id) references proactive_events(id,user_id) on delete cascade;
  end if;
end $$;

comment on constraint proactive_notifications_event_user_fkey on proactive_notifications is
  'Prevents a notification owned by one user from referencing another user''s event.';
