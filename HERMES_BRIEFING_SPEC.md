# Hermes Executive Briefing Specification

Version: 2.0 planning specification
Prepared: 31 August 2026

## Phase 2 implementation update

**CONFIRMED**: Briefing instructions and mailbox facts are now assembled separately. Untrusted sender, subject and preview text is flattened into a typed snapshot. The writing contract permits only overview, security, attention, follow-up and can-wait sections and prohibits invented deadlines, generic introductions and decorative formatting.

**CONFIRMED**: Empty states, model outages, empty model output, missing credits and exhausted briefing budgets now return a useful deterministic report rather than removing the written briefing. The UI identifies when model-written analysis was unavailable. Cache fingerprints now include both follow-up directions, suspicious status and filtered-mail count.

**REQUIRES VERIFICATION**: Semantic deduplication across email, calendar and projects belongs to later executive-intelligence phases and is not claimed here.

## Phase 4 implementation update

**CONFIRMED**: Briefing inputs now include the preserved deterministic priority score, additive executive adjustment, extracted current request, decision flag, exact stated-deadline wording, impact categories, attachment-inspection state, and recommended action. The deterministic fallback states when the available preview contains no deadline instead of manufacturing one. Cache signatures include decision-relevant annotations.

**REQUIRES VERIFICATION**: Cross-source deduplication, project change detection, meeting-preparation synthesis, and live-model comparison remain outstanding.

## Status legend

**CONFIRMED**: implemented now. **INFERRED**: not live-proven. **PROPOSED**: target. **REQUIRES VERIFICATION**: must be checked with real, privacy-safe representative data.

## 1. Current behaviour

**CONFIRMED**: The dashboard assembles deterministic mailbox priority, follow-ups, unread counts, calendar events, tasks, memory proposals, and notices. It polls every 45 seconds while visible. The briefing takes a bounded dashboard snapshot and generates prose with the single configured OpenAI model, the current soul, a 500-token cap, sanitisation, and usage accounting.

**CONFIRMED**: Briefings cache for 20 minutes and normally avoid regeneration within three minutes. A forced refresh is available. Empty, failed and budget-exhausted generation paths now produce deterministic executive prose from the verified dashboard snapshot.

**INFERRED**: The current prompt can produce useful summaries, but fixed space and model settings encourage compressed formatting. There is no typed requirement that each item explain importance, action, evidence, and what can wait.

## 2. Proposed behaviour

**PROPOSED**: The briefing reads as a private morning note, not an inbox dump:

```text
GOOD MORNING

Three things need your attention today.

1. Matter
What changed or is required. Why it matters. The decision or next action.

2. Matter
...

CAN WAIT

Short statement of routine items that do not need attention.
```

The exact heading and greeting are contextual. Do not produce a generic introduction merely to fill the template.

The briefing answers:

- What matters now?
- Why does it matter?
- What does the Director need to do or decide?
- What changed since the prior briefing?
- What is at risk or approaching a real deadline?
- What is upcoming and needs preparation?
- What can wait?

Facts, evidence-backed deadlines, and recommendations must be distinguishable.

## 3. Reason for change

**PROPOSED rationale**: A Director should be able to scan the note and act. Repeating subject lines or every high-scoring email consumes attention. Structured evidence and “can wait” handling make the briefing useful without manufacturing urgency.

## 4. Implementation approach

### 4.1 Briefing input contract

**PROPOSED**: Build a `BriefingSnapshot` from deterministic and executive-analysis data:

- generated-at time and Director timezone;
- prior briefing fingerprint/time;
- top evidence-backed attention items;
- meetings requiring preparation and verified conflicts;
- follow-ups/commitments with direction and waiting duration;
- overdue/due tasks;
- changes since prior snapshot;
- routine items safe to defer;
- data freshness/service degradation flags.

### 4.2 Selection before writing

Select and deduplicate items in code. Limit the model to writing from the approved snapshot. A newsletter cannot become urgent merely because its prose says so. One matter spanning email and meeting should appear once with combined evidence.

### 4.3 Rendering policy

Use short paragraphs and numbered items where useful. No generic “Here is your briefing”, repetitive headings, fake urgency, repeated email content, unnecessary em dashes, or invented priority. If nothing is urgent, say so directly and mention only genuinely useful upcoming items.

### 4.4 Change detection

Compute stable fingerprints from source references, update times, status, and material fields. “What changed” is based on stored snapshot metadata, not model memory. Do not retain full email bodies for comparison.

### 4.5 Degraded operation

If semantic analysis/model generation is unavailable, render a deterministic briefing from typed items. Label data freshness or missing services without exposing internal errors.

## 5. Affected files

**PROPOSED**:

- `apps/api/src/dashboard/service.ts`, `dashboard/briefing.ts`, dashboard routes.
- `mail/triage.ts`, executive analysis/context modules.
- `apps/web/src/pages/Dashboard.tsx`, `pages/Briefing.tsx`, API/shared types.
- Model/response policy, usage accounting, telemetry, fixtures/tests.

## 6. Database changes

**PROPOSED**: Add `briefing_snapshots` only if change detection and cross-session delivery require it. Store user, fingerprint, selected source references/status metadata, generated time, policy version, and optional rendered text under a retention limit. Avoid full source bodies. Existing in-memory cache remains a short-term performance layer, not the source of truth.

**REQUIRES VERIFICATION**: Retention duration, whether briefing text contains sensitive data requiring additional encryption/access controls, and whether cross-device history is a product requirement.

## 7. API changes

**PROPOSED**:

- Extend `/api/dashboard/briefing` with generated-at, data freshness, changed-since, deterministic/model rendering state, and optional item references for UI actions.
- Preserve the current refresh parameter with server-side rate/cost policy.
- Do not expose model names, prompt text, or Graph IDs in normal presentation.

## 8. Security implications

- The briefing is user-scoped and authenticated.
- All source text remains untrusted and cannot set briefing instructions.
- Snapshot storage minimises source content and has retention controls.
- Suspicious items may be described and warned about, never obeyed.
- Links/actions use opaque references and the normal approval path.
- Cached briefings must not leak across users or tenants.

## 9. Cost implications

**PROPOSED**: Selection/deduplication is deterministic. Generate at most when material fingerprint changes or the configured schedule/force policy allows it. Track briefing spend separately. Use a dedicated model role and budget. Deterministic rendering is the zero-model fallback. Longer maximum output is allowed, but item count and concise policy control actual use.

## 10. Failure cases

- Stale cached note survives a material change.
- Two source items describe one matter and are duplicated.
- No stated deadline becomes a precise date.
- A meeting is shown in the wrong timezone.
- “Can wait” hides a relationship or security risk.
- Model outage, Graph partial outage, or budget exhaustion.
- Prior snapshot missing makes “changed” unreliable.

The briefing must state freshness/degradation and avoid claims it cannot support.

## 11. Tests

**PROPOSED**:

- No urgent items; one urgent item; several items; everything routine.
- Real deadline versus no deadline; changed deadline; newly resolved item.
- Email plus calendar deduplication.
- Meeting preparation from thread evidence.
- Follow-up direction and waiting time.
- Suspicious email surfaced safely.
- Model and Graph failures, stale cache, forced refresh, category budget exhaustion.
- Style evaluation: no generic introduction, repeated content, fake urgency, internal terms, or unnecessary dashes.

## 12. Acceptance criteria

- A briefing identifies what matters, why, action/decision, changes, risk, upcoming work, and what can wait when data supports them.
- Every precise deadline and conflict is evidence-backed.
- No more than the configured top item count appears unless the Director requests detail.
- Deterministic fallback remains useful.
- Cache invalidates on material changes and remains user-scoped.
- Briefing behavioural fixtures meet factual and humanisation thresholds.
- Briefing costs are separately visible and capped.

## 13. Migration and rollback strategy

**PROPOSED**: Add `BriefingSnapshot` and deterministic rendering behind a flag. Compare the new selected items and prose with the existing briefing on fixtures. Enable new selection first, then new renderer/model policy, then persisted change detection. Rollback returns to current dashboard snapshot/generation and ignores additive snapshot records. The deterministic dashboard is never removed.
