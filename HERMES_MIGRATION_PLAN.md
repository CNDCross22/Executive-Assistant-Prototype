# Hermes Migration and Delivery Plan

Version: 2.0 planning specification
Prepared: 31 August 2026

## Implementation status

**CONFIRMED**: Phases 0 through 4 are implemented in the current workspace. Phase 4 is additive and requires no database migration. Rollback consists of removing the executive annotations and `calendar_find_slots` registration; the original deterministic triage fields, Microsoft 365 data, approvals, and migration history remain intact.

**CONFIRMED**: The connected tenant passed the read-only Graph smoke check for calendar view and `getSchedule` availability.

**REQUIRES VERIFICATION**: Full browser end-to-end behaviour, recurrence/daylight-saving edge cases, production latency, and model-backed quality comparisons remain release gates before treating Phase 4 as production-proven.

## Status legend

**CONFIRMED**: current baseline. **INFERRED**: likely operational condition. **PROPOSED**: planned migration. **REQUIRES VERIFICATION**: decision/evidence needed before advancing.

## 1. Current behaviour

**CONFIRMED**: Hermes has eight ordered SQL migrations, a monorepo build, a single safety test command, TypeScript validation, a development agent harness, and read-only Graph smoke utilities. Configuration uses one OpenAI model and one monthly budget. The current codebase contains substantial uncommitted changes that predate this planning phase.

**CONFIRMED**: The approval architecture is already persisted and migration-backed. Current production database migration state is not known from this audit. There is no general feature-flag framework, schema-version endpoint, background worker deployment, or automated rollback orchestration.

## 2. Proposed behaviour

**PROPOSED**: Deliver the upgrade in small, reversible phases with default-compatible flags, additive schemas, measured gates, and the current action engine continuously active.

```text
Phase 0  Audit and specifications
Phase 1  Foundation contracts and observability
Phase 2  Humanisation and response policies
Phase 3  Context and memory
Phase 4  Executive intelligence and calendar safety
Phase 5  Proactive notify/recommend engine
Phase 6  Attachments and selected M365 expansion
Phase 7  Production hardening
```

No phase advances because code exists. It advances when tests and acceptance evidence pass.

## 3. Reason for change

**PROPOSED rationale**: Model, prompt, data, Graph, and scheduling changes can interact with the most sensitive feature, external mutations. Separating schema, shadow computation, UI exposure, and activation keeps failures observable and rollback simple. Additive migration protects existing approvals, memory, conversations, and audit evidence.

## 4. Implementation approach

### Phase 0: Audit

Deliver these eleven documents. Do not change application behaviour. Capture test/typecheck results, current configuration without secrets, known gaps, and verification backlog.

Exit: all planning deliverables cross-checked and baseline green.

### Phase 1: Foundation

Add request/workflow IDs, model and response policy contracts, typed tool metadata, privacy-safe telemetry, category cost attribution, and feature flags. Wire or explicitly replace the dormant `audit_events` design.

Exit: current behaviour reproduced under default policy; every tool metadata invariant passes; correlated telemetry contains no sensitive content.

### Phase 2: Humanisation

Version/rewrite soul, align fallback persona, add response modes/adaptive limits and deterministic action/error rendering, create 100+ behavioural fixtures, redesign briefing selection/writing.

Exit: zero hard behavioural failures and measurable naturalness/utility improvement.

### Phase 3: Context and memory

Add typed context assembler, active action state, verified recent facts, scoped memory, conflict/precedence, expiry/provenance UI, and user-scoped fallbacks.

Exit: long/reference scenarios pass; no cross-user/person/project contamination; rollback to legacy context tested.

### Phase 4: Executive intelligence

Add thread-aware evidence extraction over deterministic shortlist, priority recommendations, deterministic calendar overlap, deadline evidence validation, and expanded briefing inputs. Add free/busy/recurrence only as separately verified subphases.

Exit: no fabricated deadline, improved decision metrics, acceptable cost/latency, and safe scheduling scenarios pass.

### Phase 5: Proactive engine

**CONFIRMED (31 August 2026)**: Initial notify/recommend scope implemented. Migrations `0011_proactive_engine.sql` and `0012_proactive_user_binding.sql` are additive and applied. Dashboard scanning and authenticated notice/policy controls are active; unattended polling is implemented but defaults off. No proactive external mutation or model call exists.

Add scheduler, structured policies/events/notifications, idempotency, category budget, quiet hours, and observe-only telemetry. Progress to notify/recommend/prepare only through separate gates.

Exit: false-positive/duplicate/noise/cost targets met; no proactive external mutation.

### Phase 6: M365 expansion

Attachments metadata, safe retrieval/extraction, then Teams, OneDrive/SharePoint, Planner, and selected Office capabilities. Each has separate consent, tools, safety, and rollback.

Exit: least-privilege review, test tenant proof, security tests, and operational failure runbook per integration.

### Phase 7: Production hardening

Security review, dependency review, performance/load/concurrency testing, budget forecasting, backup/restore, migration rehearsal, incident drills, observability dashboards, and documentation reconciliation.

Exit: production readiness checklist signed with all required live verifications complete.

## 5. Feature flags and compatibility

**PROPOSED** example flags:

- `HERMES_MODEL_POLICY_V2`
- `HERMES_RESPONSES_API`
- `HERMES_RESPONSE_MODES`
- `HERMES_CONTEXT_V2`
- `HERMES_MEMORY_SCOPES`
- `HERMES_EXECUTIVE_ANALYSIS`
- `HERMES_BRIEFING_V2`
- `HERMES_PROACTIVE_OBSERVE`
- per-integration attachment/M365 capability flags

Flags default off until their phase. Legacy `OPENAI_MODEL` and existing context/briefing paths remain available through the compatibility window. Flags are server-controlled and cannot be changed by the model or untrusted content.

## 6. Affected files

**PROPOSED**: All implementation areas identified by the focused specifications, plus `.env.example`, setup diagnostics, root scripts, CI, README, `docs/AI_AGENT.md`, `docs/MEMORY.md`, `docs/SECURITY.md`, and `docs/MICROSOFT_GRAPH.md`. Each change set includes its schema, API/shared types, UI, tests, and documentation together.

## 7. Database changes

**PROPOSED** rules:

- Continue numbered, idempotent forward migrations.
- Prefer nullable/additive columns and new tables.
- Index before enabling high-volume reads/jobs.
- Backfill in bounded batches and record progress.
- Never rewrite/delete approval or audit history as routine rollback.
- Test each migration from a copy of every supported prior schema version.
- Document compatibility window: new code with old schema, new code with new schema, and old code with new schema where rollback needs it.

Expected areas: usage attribution, conversation facts, memory scope/provenance/conflict, approval fingerprints/receipts, briefing snapshots, proactive policies/events/notifications, attachment metadata, and wired telemetry/audit.

**REQUIRES VERIFICATION**: Production schema version, backup/point-in-time recovery, deployment transaction limits, lock tolerance, row volumes, RLS, retention, and restore rehearsal.

## 8. API changes

**PROPOSED** rules:

- Add optional fields first; avoid breaking web/server deploy ordering.
- Version breaking endpoints or provide dual parsing.
- Update shared types and both ends in one compatible release.
- Keep internal model/mode/tool details out of Director-facing copy.
- Every new write endpoint documents risk, validation, ownership, approval/confirmation, idempotency, failure states, and receipt.
- Status/setup endpoints report feature and dependency readiness without secrets.

## 9. Security implications

- Approval remains active in every phase and is not feature-flagged off.
- Feature flags cannot broaden permission beyond consented scopes/tool registry.
- Schema backfills preserve user/tenant ownership.
- Shadow model/context processing follows the same data-minimisation rules as active processing.
- New M365 scopes are consented only when the capability is ready and can be independently disabled.
- Rollback never blindly retries unknown mutations.
- Secrets are rotated/reviewed before production and never written to migration logs.

## 10. Cost implications

**PROPOSED**: Phase 1 establishes attribution before new model workloads. Each later phase has a cost baseline, expected delta, category cap, and rollback threshold. Shadow/evaluation runs use development budgets. Proactive background defaults to zero. Attachment scanning/extraction and telemetry storage receive separate infrastructure estimates. Budget exhaustion must degrade to deterministic/read-only behaviour where possible.

## 11. Failure cases and rollback triggers

Rollback or flag-disable triggers include:

- any approval bypass, duplicate execution, wrong recipient/time/target, or unsupported success claim;
- fabricated deadline or cross-user context/memory;
- cost/latency beyond agreed threshold;
- database lock/backfill instability;
- increased prompt-injection compliance;
- unacceptable briefing false urgency or proactive noise;
- provider/API incompatibility or inaccurate usage accounting;
- new Graph scope/capability failure in the target tenant.

Unknown mutation outcomes are investigated, not retried during rollback.

## 12. Tests and gates

**PROPOSED** for every phase:

1. Unit and type checks.
2. Domain integration tests.
3. Database migration/compatibility tests where applicable.
4. End-to-end action lifecycle where behaviour changes.
5. Behavioural evaluation for model/prompt/context/briefing changes.
6. Security/adversarial tests.
7. Cost and latency comparison.
8. Staging/read-only live smoke; test-tenant mutation smoke when required.
9. Rollback rehearsal.

Evidence is attached to the release decision. “Implemented” and “enabled” are separate states.

## 13. Acceptance criteria

- Each phase has an owner, flag, baseline, success thresholds, monitoring, and rollback trigger before coding is enabled.
- Application behaviour remains compatible while flags are off.
- Database changes are additive and rehearsed.
- All 30 acceptance scenarios and 100+ behavioural fixtures pass before relevant production activation.
- Cost is attributed and capped before briefing/background expansion.
- Security review precedes attachments, proactive work, and new M365 writes.
- Documentation matches the enabled behaviour, not merely merged code.

## 14. Migration and rollback strategy

**PROPOSED**:

- Model: map all roles to legacy `OPENAI_MODEL`; disable Responses adapter.
- Response: restore versioned current soul/prompt and fixed legacy rendering.
- Context: disable V2 and return to recent eight-turn plus current memory retrieval.
- Memory: ignore new scope/conflict metadata while retaining rows; keep user-scoped fallback fix.
- Executive analysis: hide semantic annotations and use deterministic triage/calendar listing.
- Briefing: return to current snapshot/model generator or deterministic dashboard.
- Proactive: stop scheduler, disable policies, expire queued events; no external mutations need reversal.
- Attachments/M365: disable capability/tool exposure and remove incremental scopes at the tenant when operationally approved.
- Database: leave additive structures; use a forward corrective migration rather than destructive down migration in production.

## 15. Implementation sequence for the five highest-impact changes

**PROPOSED**:

1. Foundation policy/telemetry contracts, because every later change needs measurement and rollback.
2. Layered context and active action facts, because continuity is the largest immediate user benefit.
3. Response/soul/briefing humanisation with behavioural gates.
4. Scoped memory and executive evidence analysis, enabled independently.
5. Approval freshness/receipts completed across tool families before any proactive or expanded M365 capability.

Proactive operation follows these five rather than competing with them. This sequence improves understanding first, then anticipation, while external authority remains unchanged.

## 16. Requires-verification register

- Production database migration version, backup, RLS, and restore capability.
- Live OpenAI model access, pricing, rate limits, region, and data-retention settings.
- Live Graph scopes, API shapes, throttling behaviour, recurrence/free-busy requirements, attachment endpoints, and external attendee product policy.
- Deployment topology suitable for durable scheduler/queue and hidden background workers.
- Director’s timezone, Australian English preference, quiet hours, notification channel, and acceptable proactive frequency.
- Legal/privacy retention requirements for conversation, briefing, facts, attachments, telemetry, and evaluation data.

No item in this register may be silently converted into a confirmed implementation assumption.
