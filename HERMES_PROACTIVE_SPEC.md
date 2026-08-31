# Hermes Proactive Executive Assistant Specification

Version: 2.0 planning specification
Prepared: 31 August 2026

## Status legend

**CONFIRMED**: current implementation. **INFERRED**: likely but not demonstrated. **PROPOSED**: future target. **REQUIRES VERIFICATION**: external/product decision required.

## Phase 5 implementation status

**CONFIRMED (31 August 2026)**: The first controlled proactive release is implemented.

- Six deterministic triggers cover suspicious mail, priority mail, replies owed, overdue follow-ups, calendar conflicts, and meetings in the next 24 hours.
- Every event carries a user, stable dedupe key, source version, evidence, confidence, severity, expiry, policy decision, and source link where available.
- Policies are structured and user-scoped, with enable/disable, notify/recommend outcome, minimum severity, timezone-aware quiet hours, cooldown, and per-local-day cap.
- Events, policies, in-app delivery receipts, and run diagnostics are durable through migrations `0011_proactive_engine.sql` and `0012_proactive_user_binding.sql`. Database ownership is composite-key enforced, and the fallback store is physically partitioned by user.
- Dashboard refresh performs a bounded read-only scan. An unattended scheduler exists but is off by default and must be enabled with `HERMES_PROACTIVE_BACKGROUND=true`.
- The dashboard exposes notices, recommendations, source links, mark-read, snooze, dismiss, and per-trigger enable/disable controls.
- No proactive path calls a mutating Microsoft 365 method, creates an approval, drafts a message, sends an external notification, or invokes a model. The existing approval boundary is unchanged.

**CONFIRMED LIMITS**: Delivery is in-app only. There is no push/email/SMS channel, durable multi-worker lease queue, model analysis, draft preparation, unusual-workload detector, recurring administrative trigger, or automatic external action. Background polling remains opt-in and single-process.

## 1. Current behaviour

**CONFIRMED**: Hermes was fully reactive at audit time. It now creates controlled in-app notices during dashboard scans and can perform read-only background scans when explicitly enabled. It still cannot initiate an external conversation or perform an autonomous Microsoft 365 mutation.

**CONFIRMED**: Current deterministic signals already provide useful trigger inputs: upcoming events, priority mail, waiting follow-ups, tasks, memory proposals, and suspicious content.

## 2. Proposed behaviour

**PROPOSED**: Introduce a proactive event engine with constrained outcomes:

```text
source snapshot/change
  -> deterministic trigger
  -> deduplication and freshness check
  -> user policy evaluation
  -> optional bounded analysis
  -> one of:
       ignore
       notify
       recommend
       prepare a draft/proposal
  -> notification
  -> if Director requests action, normal preview and approval
```

No event may silently perform an externally visible mutation. Existing approval rules apply unchanged.

Potential triggers: upcoming important meeting, overdue response, approaching evidence-backed deadline, unresolved high-priority email, calendar conflict, unusual workload, recurring administrative reminder, and follow-up becoming overdue.

## 3. Reason for change

**PROPOSED rationale**: A capable Executive Assistant notices timing and change without being asked. The value is anticipation, not unsupervised authority. A policy-driven event system can deliver this while protecting attention, privacy, budget, and action safety.

## 4. Implementation approach

### 4.1 Phases

1. **Observe-only**: implemented through `HERMES_PROACTIVE_DELIVERY=observe`.
2. **Notify-only**: implemented for deterministic in-app reminders.
3. **Recommend**: implemented as evidence-backed in-app recommendations.
4. **Prepare**: create an internal draft/proposal, never send.
5. **Limited reversible automation**: consider only after a separate explicit product/security decision. It remains out of the initial target.

### 4.2 Event contract

**PROPOSED** fields: event ID, user, type, source references and versions, detected time, effective/deadline time, severity, confidence, evidence, policy decision, dedupe key, expiry, status, notification state, and related workflow/approval ID.

### 4.3 Policy contract

Structured policies include trigger, conditions, allowed outcome, quiet hours, channel, cooldown, priority threshold, budget category, and confirmation requirement. Natural-language preferences are parsed into a preview and approved structured policy. “Never send without approval” remains a system guarantee, not a removable preference.

### 4.4 Scheduling and idempotency

Use a durable scheduler/queue appropriate to the deployment, with leases, retries, idempotency keys, and dead-letter visibility. Re-read source metadata before delivery. A duplicate run must not duplicate a notification or proposal.

### 4.5 Attention protection

Batch low-value items, respect quiet hours/timezone, suppress unchanged events, cap daily notifications, and let the Director snooze/dismiss/tune a policy. Security and imminent real deadlines may use a higher channel only under explicit policy.

## 5. Affected files

**CONFIRMED for the initial release**:

- New `apps/api/src/proactive/` trigger, policy, scheduler, event, and notification modules.
- Dashboard/executive/context/mail/calendar/task services as read-only sources.
- Approval engine and registry reused for proposals/actions.
- Auth/MSAL token acquisition for background reads.
- Routes, shared contracts, Dashboard/Assistant notification UI, settings/memory UI.
- Migrations, telemetry, deployment configuration, tests/docs.

## 6. Database changes

**CONFIRMED for migrations `0011` and `0012`**:

- `proactive_policies`: user, trigger type, structured conditions, allowed outcome, schedule/quiet hours, enabled state, budget class, created/confirmed timestamps.
- `proactive_events`: user, dedupe key, source refs/versions, evidence metadata, detected/effective/expiry times, status, policy/version.
- `notifications`: event, channel, delivery state, shown/acknowledged/snoozed times.
- Optional durable job/lease table if the deployment platform does not supply a queue.

Indexes and uniqueness must enforce user-scoped deduplication. Retention removes stale metadata without losing action audit receipts.

## 7. API changes

**CONFIRMED for authenticated in-app APIs**:

- List/create/update/disable proactive policies with preview/confirmation for material behavioural changes.
- List/acknowledge/snooze notifications.
- Convert recommendation to a normal chat proposal.
- Authenticated diagnostics for next run, last success, degraded sources, and category budget.
- No client endpoint can mark an unapproved external mutation as approved.

**PROPOSED**: Policy preview/confirmation for natural-language policy creation and recommendation-to-chat handoff remain future work. Current settings are explicit, structured, reversible UI controls.

## 8. Security implications

- Background reads require the same user, tenant, delegated scopes, encrypted cache, and least privilege.
- No proactive external mutation bypasses approval.
- Source content is untrusted and cannot create/change policies.
- Policies are structured, user-scoped, auditable, and protected from prompt injection.
- Notifications minimise sensitive content, especially on external channels/lock screens.
- Job logs exclude message bodies and tokens.
- Revocation, logout/reconnect state, disabled account, or tenant mismatch stops runs safely.

## 9. Cost implications

**PROPOSED**: Deterministic triggers run first. Background model budget defaults to zero. When enabled, separate daily/monthly caps, per-event limits, cooldowns, and batching prevent budget capture. Interactive requests retain reserved capacity. Report spend and usefulness by trigger/policy.

## 10. Failure cases

- Duplicate jobs/notifications.
- Missed or late event due to scheduler outage.
- Stale event after the Director already acted.
- Notification fatigue from noisy thresholds.
- Wrong timezone or quiet-hours handling.
- Token/consent expiry during background read.
- Partial Graph data or rate limiting.
- Model budget exhausted.
- Policy ambiguity or conflict.
- Prepared draft contains stale recipients/content.

Safe behaviour is suppress, expire, or notify uncertainty. Never auto-retry an uncertain mutation because the initial system does not perform proactive mutations.

## 11. Tests

**PROPOSED**:

- Trigger detection and non-trigger near misses.
- Idempotent duplicate schedule runs and concurrent workers.
- Source changed/resolved before notification.
- Quiet hours, daylight saving, snooze, cooldown, daily cap.
- Conflicting policies and immutable approval boundary.
- Prompt injection in every source type.
- Revoked token, Graph 429/timeout/partial outage, model failure, category budget exhaustion.
- Cross-user/tenant isolation.
- End-to-end notify, recommend, prepare, approve, execute, and receipt.

## 12. Acceptance criteria

- Initial release performs no proactive external mutation.
- Every event has evidence, expiry, dedupe key, user, source version, and policy decision.
- Duplicate runs produce at most one active notification/proposal.
- Quiet hours and notification caps work in the Director’s timezone.
- Background spend is separately measured/capped and cannot consume reserved interactive budget.
- Disabling a policy stops future events without deleting audit history.
- Security/reliability metrics meet thresholds in observe-only mode before notifications are enabled.

## 13. Migration and rollback strategy

**PROPOSED**: Ship schema and observe-only workers first. Run for a measured period and inspect false-positive, duplicate, latency, and cost rates. Enable notify-only for one trigger, then expand. Recommend/prepare require separate gates. Rollback disables scheduler/policies and leaves interactive Hermes untouched. Existing events expire; no deletion or external reversal is needed.
