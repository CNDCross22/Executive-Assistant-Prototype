-- Remove any historical duplicate proposals before enforcing one pending
-- action per user and conversation. The newest proposal is the only one that
-- could reasonably match the visible approval card.
with ranked as (
  select id,
         row_number() over (partition by user_id, conversation_id order by created_at desc) as position
  from action_approvals
  where status = 'pending'
)
update action_approvals a
set status = 'expired', result_summary = 'Superseded by a newer proposal.'
from ranked r
where a.id = r.id and r.position > 1;

create unique index if not exists action_approvals_one_pending_per_conversation
  on action_approvals (user_id, conversation_id)
  where status = 'pending' and conversation_id is not null;
