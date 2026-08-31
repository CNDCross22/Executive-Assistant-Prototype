# Hermes Executive Reasoning Specification

Version: 2.0 planning specification
Prepared: 31 August 2026

## Phase 4 implementation update

**CONFIRMED**: Hermes now creates a bounded, deterministic assessment of each shortlisted email preview: current request, unanswered questions, decision requirement, exact stated-deadline evidence, explicit commitments, consequence language, impact categories, attachment presence, confidence, and a conservative next-step recommendation. Quoted history is removed before extraction. Suspicious content is forced into safe handling rather than presented as an ordinary request.

**CONFIRMED**: The original triage score remains separately visible. Evidence-backed deadline, decision, response, impact, security, and attachment signals are additive and individually explained. The dashboard and briefing receive the structured fields, and opening a message retrieves a bounded thread chronology before reporting who currently owes the reply.

**CONFIRMED**: Calendar listing reports deterministic overlaps. Create and time-change previews query the calendar view, name conflicts, preserve the requested time, and remain approval-controlled. The new read-only `calendar_find_slots` tool intersects Microsoft Graph `getSchedule` free/busy views for the Director and exact resolved attendee addresses, respects Outlook working hours, and never creates a meeting.

**CONFIRMED**: The read-only Microsoft 365 smoke suite passed against the connected tenant, including calendar view and a real `getSchedule` availability response. No Microsoft 365 data was changed.

**REQUIRES VERIFICATION**: This phase deliberately uses deterministic evidence extraction rather than a model-backed semantic Stage 2. Daylight-saving boundaries, recurring-event edge cases, partial attendee schedule errors, browser end-to-end rendering, and model interpretation of the new structured results still require test-tenant or human evaluation. Attachment content remains unread.

## Status legend

**CONFIRMED**: current behaviour. **INFERRED**: not fully demonstrated. **PROPOSED**: target. **REQUIRES VERIFICATION**: needs Graph/product/evaluation proof.

## 1. Current behaviour

**CONFIRMED**:

- Mail triage is deterministic and transparent. It scores automation, direct/CC status, known correspondents, participated threads, unread/high importance, external sender, waiting time, recency, and recipient count.
- Follow-up detection compares bounded sent/inbox windows and distinguishes replies owed to/from the Director.
- Per-request structured extraction now covers request, decision, deadline evidence, commitments, consequences, impact categories, questions, attachment metadata, and recommendations. It is not persisted as a parallel mailbox.
- Reading an important message retrieves up to 20 thread messages and returns a bounded chronology and current reply direction. Full bodies of older thread messages are not bulk-loaded.
- Dedicated free/busy reads use Microsoft Graph `getSchedule` for exact addresses. There is still no autonomous scheduling negotiation or silent invitation workflow.
- The reasoning framework is encoded as deterministic validated state; a separately budgeted model-semantic Stage 2 remains proposed.

## 2. Proposed behaviour

**PROPOSED**: For relevant requests, Hermes forms a private structured assessment without exposing chain-of-thought:

- request and actor;
- people/relationship evidence;
- consequence and business impact;
- stated deadline and exact evidence, or no stated deadline;
- dependencies and commitments;
- response/decision owner;
- reversibility and risk;
- safest next action;
- whether Hermes can prepare or perform it;
- exact approval requirement.

User output contains the conclusion, decisive evidence, uncertainty, and recommendation only.

### Priority policy

**PROPOSED**: Preserve deterministic scoring as Stage 1. Stage 2 analyses only the highest-value or ambiguous shortlist using thread and calendar evidence. Stage 2 may annotate or reorder within bounded policy, but cannot silently invent urgency or erase deterministic evidence.

Suggested factors: explicit deadline, business/financial/operational impact, relationship importance, participant/customer impact, security risk, Director-only decision, waiting time, dependency, and reversibility.

## 3. Reason for change

**PROPOSED rationale**: Executive usefulness requires understanding what someone wants and the consequence of delay, not merely finding messages. A two-stage design preserves cost, transparency, and deterministic fallbacks while adding semantic judgement where it matters.

## 4. Implementation approach

### 4.1 Evidence schema

**PROPOSED**: Introduce a versioned `ExecutiveItem` schema:

```text
source references and timestamps
actor/participants
request summary
decision required
questions and commitments
deadline: { statedText, parsedInstant?, evidenceRef } or none
dependencies
impact/risk categories
response owed and evidence
deterministic score/signals
semantic recommendation and confidence
```

No precise deadline is renderable unless `evidenceRef` points to source text or authoritative event/task time.

### 4.2 Thread-aware email analysis

**PROPOSED**: For an important message, retrieve enough of the conversation thread to identify the latest open request and prior commitments. Use bounded size, plain text, and untrusted-content labels. Deduplicate quoted history. Do not assume the newest email alone contains all context.

### 4.3 Calendar reasoning

**PROPOSED** phases:

1. Normalize event lookup and deterministic overlap/conflict detection.
2. Add recurrence only after Graph schema/product rules are verified.
3. Add dedicated `getSchedule`/free-busy if least-privilege Graph requirements and tenant support are verified.
4. Generate ranked scheduling recommendations using working hours, timezone, conflicts, attendee availability, and approved preferences.
5. Consider negotiation only as approval-controlled proposals, never autonomous invitation sending.

“Afternoon” follows a configured scheduling-window preference only if one exists and is applicable. Otherwise Hermes asks for a time before creating the event.

### 4.4 Recommendation validation

**PROPOSED**: A validator checks deadline evidence, target identity, conflict state, approval need, and unsupported certainty before rendering. Deterministic data and model interpretation remain distinguishable in internal state and telemetry.

## 5. Affected files

**PROPOSED**:

- `mail/triage.ts`, `mail/suspicion.ts`, `graph/mail.service.ts`.
- `graph/calendar.service.ts`, calendar tools and timezone utilities.
- `dashboard/service.ts`, `dashboard/briefing.ts`.
- New `agent/executive/*` and evidence validators.
- Prompt/context/response policy, shared types, Dashboard/Briefing UI, tests and fixtures.

## 6. Database changes

**PROPOSED**: Initially none for per-request analysis. Store compact executive facts only through the context fact design with provenance/expiry. If recurring unresolved matters must persist, add user-scoped `executive_items` with source refs, status, last-seen time, evidence version, and expiry. Do not copy full email threads into a parallel mailbox.

## 7. API changes

**PROPOSED**:

- Dashboard may return evidence-backed `why`, `actionRequired`, `deadline`, `risk`, `changedSince`, and `canWait` fields.
- Calendar preview adds explicit timezone, conflict status, invitation behaviour, and recurrence only when supported.
- No arbitrary query or Graph URL is accepted from the model/client.
- Preserve existing fields while adding optional structured annotations.

## 8. Security implications

- All external text remains untrusted during extraction and summary.
- A malicious “deadline” or instruction is reportable content, not system policy.
- Semantic ranking does not grant tools or approval authority.
- Thread retrieval uses least data required and plain-text conversion.
- External attendees require explicit policy/clarification; current code rejects unresolved/external examples in relevant scheduling flows and must not be silently loosened.
- Model outputs cannot supply authoritative IDs or execution state.

## 9. Cost implications

**PROPOSED**: Stage 1 remains zero-model deterministic logic. Stage 2 is capped by item count, thread length, frequency, and a purpose/category budget. Cache evidence by source version where privacy and freshness permit. Measure marginal value per analysed item. Full-mailbox semantic processing is out of scope.

## 10. Failure cases

- Model invents a deadline or misreads relative date.
- Quoted thread history is mistaken for the current sender’s request.
- A later reply closes a commitment but the system marks it unresolved.
- Conflict detection misses recurrence or timezone conversion.
- Two Sarahs create attendee ambiguity.
- Free/busy data is incomplete or forbidden.
- Stage 2 becomes unavailable or budget-exhausted.

Fallback: show deterministic score/signals, state that semantic interpretation is unavailable, and ask for clarification before action. Never silently move a meeting.

## 11. Tests

**PROPOSED**:

- Stated deadline, no deadline, vague urgency, relative dates/timezones.
- Request/decision/question/commitment extraction from realistic threads.
- Latest message versus quoted older request.
- Director owes reply, other party owes reply, auto-reply/newsletter exclusions.
- High deterministic/low semantic importance and the reverse.
- Calendar exact conflict, adjacent events, timezone boundary, all-day event, ambiguous “afternoon”, recurrence later.
- Ambiguous/internal/external attendee resolution.
- Suspicious/prompt-injected email analysis and requested forwarding through approval.
- Budget/model failure with deterministic fallback.

## 12. Acceptance criteria

- Every reported precise deadline has source evidence.
- Every recommendation distinguishes fact from interpretation.
- Deterministic triage remains available and observable.
- Only a bounded shortlist receives semantic analysis.
- Important thread recommendations consider relevant prior messages where available.
- Scheduling checks time, timezone, conflicts, attendee resolution, invitation behaviour, preview, and approval.
- No conflict is silently resolved by changing the requested time.
- Behavioural evaluations show improved decision usefulness without reduced factual accuracy.

## 13. Migration and rollback strategy

**PROPOSED**: Add evidence extraction in shadow mode next to current triage. Compare disagreement and false-deadline rates. Display annotations only after accuracy gates; keep current scores and dashboard fields. Enable thread-aware analysis for a small top-N before broadening. Calendar phases ship independently. Rollback disables semantic annotation and uses existing deterministic triage/listing with no data loss or approval changes.
