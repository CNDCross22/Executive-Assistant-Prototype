-- A placeholder address must never remain executable after directory
-- resolution has been tightened. This is deliberately limited to pending
-- calendar proposals; it does not touch Microsoft 365.
update action_approvals
set status = 'expired',
    result_summary = 'Invalidated because it contained a placeholder attendee address.'
where status = 'pending'
  and tool_name in ('calendar_create', 'calendar_update')
  and (
    preview::text ilike '%@example.com%'
    or preview::text ilike '%@example.org%'
    or preview::text ilike '%@example.net%'
  );
