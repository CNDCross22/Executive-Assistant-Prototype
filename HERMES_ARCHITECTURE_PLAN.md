# Hermes Architecture Plan

Version: 2.0 planning specification
Prepared: 31 August 2026

## Status legend

**CONFIRMED** means present in the audited repository. **INFERRED** means likely but not live-verified. **PROPOSED** is a target. **REQUIRES VERIFICATION** identifies a release prerequisite.

## 1. Current behaviour

**CONFIRMED**: Hermes is a TypeScript monorepo with a React web client, Fastify API, shared types, PostgreSQL/Supabase persistence, Microsoft Graph services, and one OpenAI provider. The orchestrator is the central coordinator. It mixes request-state handling, memory retrieval, prompt construction, skill routing, model looping, tool execution, approval handling, cost recording, and response safety.

**CONFIRMED**: This concentration has a useful property: the safety path is visible and reviewable. It also means context, response policy, model policy, and telemetry changes would all compete inside `agent/orchestrator.ts` if added without new boundaries.

**CONFIRMED**: The registry exposes only selected tools. Each tool already owns name, description, Zod schema, risk, capability, execution, and where applicable preview construction. All 22 mutations are approval-controlled in chat.

**CONFIRMED**: There is no background worker, job scheduler, event engine, queue, notification store, attachment pipeline, or service abstraction for Teams/OneDrive/SharePoint.

**CONFIRMED**: Persistence contains tenants, users, OAuth connections, sessions, audit events, usage, conversations/messages, memory entries/signals, skills, and approvals. `audit_events` and database-backed `skills` are not wired into runtime behaviour.

## 2. Proposed behaviour

**PROPOSED**: Evolve to a modular decision pipeline while retaining one deterministic execution boundary:

```text
Request envelope
  -> intent and response-policy classification
  -> context assembler
       recent relevant turns
       pending action state
       verified recent facts
       approved memory
       executive context
  -> capability/skill selection
  -> model policy selection
  -> bounded reasoning/tool loop
  -> executive evidence validator
  -> response renderer
  -> claim guard and sanitiser

All mutations, whether interactive or future proactive:
  -> typed tool registry
  -> verified preview
  -> persisted exact approval
  -> atomic execution
  -> durable action receipt
```

No model should call Graph directly, grant itself tools, select its own risk level, or turn a recommendation into an execution.

## 3. Reason for change

**PROPOSED rationale**:

- Context selection should be testable without invoking a model.
- Model selection, response length, and purpose budgets should be policy decisions rather than call-site constants.
- Executive analysis should produce evidence-bearing structured state before prose.
- Action safety should remain independent of model quality.
- Telemetry should observe each stage without logging sensitive content.
- Future proactive work should reuse the same recommendation, preview, approval, and receipt components rather than creating a second action path.

**CONFIRMED (Phase 5)**: The proactive subsystem is a separate read-only path under `apps/api/src/proactive/`. It creates evidence-backed internal recommendations and in-app delivery receipts only. Any future conversion into a Microsoft 365 action must return to the existing interactive tool, preview, approval, and execution path.

## 4. Implementation approach

### 4.1 Request envelope

**PROPOSED**: Introduce an internal `AssistantRequest` carrying `requestId`, user, tenant, conversation, message, timezone, start time, interaction source, and optional parent workflow. Generate the ID at the HTTP boundary and propagate it to model usage, tool activity, approvals, facts, logs, and receipts.

### 4.2 Context assembler

**PROPOSED**: Add a pure context-selection service. Inputs are the current request, recent stored turns, pending action, recent verified facts, active memories, and optional executive snapshot. Output is typed sections plus a token estimate and exclusion reasons. The orchestrator consumes this object; it no longer decides context by slicing arrays inline.

### 4.3 Response policy

**PROPOSED**: Add an internal mode and policy object containing target length, maximum completion, required fields, tone constraints, whether a recommendation is expected, and whether action evidence is required. Internal names remain server-only.

### 4.4 Model policy

**PROPOSED**: Add a policy resolver that chooses a configured model role based on response mode, ambiguity, tool workflow, sensitivity, and remaining category budget. The provider accepts explicit model, reasoning effort, and API-path options per call instead of storing one immutable model instance.

### 4.5 Tool metadata

**PROPOSED**: Extend the existing `Tool` contract rather than replace it. Add category, read/write effect, confirmation policy, idempotency class, target type, preview requirements, target-freshness policy, receipt policy, and privacy classification. Generate provider definitions and observability metadata from the same source.

### 4.6 Verified facts and evidence

**PROPOSED**: Represent recent tool-derived facts as compact typed records, for example person resolution, selected message/thread, draft text hash, event time, source timestamp, and expiry. Facts cannot carry instructions. Mutation previews must resolve against Graph again and never trust a fact as execution authority.

### 4.7 Executive analysis

**PROPOSED**: Keep deterministic shortlist creation. Analyse only selected items into a schema containing request, deadline text/evidence, decision, commitment, dependency, risk, response owed, confidence, and source references. The user-facing renderer may state a precise deadline only when evidence is present.

### 4.8 Telemetry

**PROPOSED**: Emit allowlisted structured events for stage timings, model policy, token/cost counts, tool status, approval lifecycle, memory retrieval/proposal, security blocks, briefing, and proactive recommendations. Store IDs and classifications, not full message bodies or secrets.

### 4.9 Proactive runtime

**PROPOSED**: Add only after interactive foundations pass. A scheduler produces idempotent events; a policy engine turns them into notify/recommend/prepare-draft outcomes; notification delivery records acknowledgement. Any write uses the existing approval engine.

## 5. Affected files

**PROPOSED**:

- Refactor carefully: `apps/api/src/agent/orchestrator.ts`, `prompt.ts`, `skills.ts`, `registry.ts`, `tools/types.ts`, `approvals.ts`, `guards.ts`, `sanitise.ts`.
- Extend: `apps/api/src/ai/provider.ts`, `openai.ts`, `index.ts`, `cost.ts`, `config/env.ts`.
- Add: `apps/api/src/agent/context/`, `response-policy.ts`, `executive/`, `telemetry/`, later `proactive/`.
- Extend stores/routes: conversations, memory, dashboard, assistant and system routes.
- Extend web/shared: API contracts, Assistant approval receipts, Memory provenance, Dashboard notifications.
- Extend migrations and technical documentation.

**REQUIRES VERIFICATION**: Exact module boundaries should be confirmed after measuring orchestrator coupling with characterization tests. Avoid splitting files if the new boundary has no independently testable contract.

## 6. Database changes

**PROPOSED**:

- `ai_usage`: add nullable `request_id`, `conversation_id`, `workflow_id`, and `model_role`, or normalize these into a linked usage context table.
- `conversation_facts`: user, conversation, type, JSON value, source type/ref/time, confidence, sensitivity, expiry, superseded time.
- `action_approvals`: target fingerprint/version, proposed-at source time, execution-attempt ID, and structured receipt.
- `audit_events`: either wire the existing table with privacy-safe details or introduce a versioned event table and explicitly deprecate the old promise.
- No proactive tables before Phase 5.

Use additive migrations, indexes including user/expiry, bounded retention, and foreign keys. Do not store full mailbox copies.

## 7. API changes

**PROPOSED**:

- Keep `/api/assistant/chat` compatible; add optional `requestId`, `state`, and receipt presentation fields.
- Add diagnostic policy information to authenticated setup/status without exposing secrets or raw prompts.
- Extend memory responses with provenance, scope, expiry, conflict status, and last-confirmed time.
- Add internal or authenticated endpoints for evaluation only under non-production controls.
- Later add notification policy/event endpoints with user ownership checks.

## 8. Security implications

**PROPOSED**:

- The approval registry remains the only execution route for mutations.
- Context and facts are scoped to exact user and conversation; cross-conversation reuse requires explicit durable memory or safe executive-context policy.
- Untrusted content retains provenance through extraction and rendering.
- Telemetry schemas use allowlists and reject arbitrary payload objects.
- Background jobs acquire user-scoped tokens server-side and cannot bypass consent or approval.
- Model/API migrations must preserve opaque references and claim evidence.

## 9. Cost implications

**PROPOSED**: The architecture adds small database and telemetry costs. It should reduce repeated reads and irrelevant prompt tokens. Semantic executive analysis and future proactive runs create new model spend, so each has a category budget and deterministic prefilter. Context size is a budgeted resource, not an invitation to pass all history.

## 10. Failure cases

- Context assembly fails or exceeds its token budget: use the current recent-turn path and mark degraded telemetry.
- Policy resolver chooses an unavailable model: fall back only to an explicitly configured compatible model, never an arbitrary name.
- Fact storage fails after a successful read: answer from current result, omit future fact reuse, and do not misreport the read.
- Telemetry storage fails: log a redacted operational warning without failing a successful Director request.
- Approval receipt storage fails after confirmed execution: report confirmed execution and separately flag audit degradation.
- A scheduler duplicates an event: idempotency key prevents duplicate notification/proposal.
- Any safety classifier fails: default to no mutation and a clear explanation.

## 11. Tests

**PROPOSED**:

- Characterization tests around the current orchestrator before extraction.
- Pure unit tests for request envelopes, response and model policy, context budgeting, fact expiry, tool metadata invariants, and telemetry redaction.
- Integration tests with fake OpenAI and Graph providers across read, preview, approval, execution, receipt, and unknown result.
- Migration tests from every existing schema version.
- Load/concurrency tests for approval claims and proactive deduplication.
- Behavioural evaluation gates before enabling a policy change.

## 12. Acceptance criteria

- Existing approval and claim-guard tests remain green.
- The orchestrator delegates to typed context/model/response policies without duplicating their logic.
- Every registered tool has complete metadata validated at startup/test time.
- Request IDs correlate model, tool, approval, and receipt events.
- No raw email body, token, secret, cookie, or authorisation header appears in telemetry.
- Legacy configuration and API clients continue working during rollout.
- A failed new module has a tested conservative fallback.

## 13. Migration and rollback strategy

**PROPOSED**:

1. Add types, migrations, and no-op/default-compatible policy layers.
2. Add characterization tests and compare outputs against the legacy orchestrator.
3. Enable context and response policies independently per environment.
4. Enable model role routing in evaluation, then a small interactive canary.
5. Add executive annotations as supplemental data, never replacing deterministic ranking initially.
6. Introduce proactive notify-only operation last.

Rollback uses feature flags and the legacy `OPENAI_MODEL`/recent-turn path. Additive columns remain dormant. Never drop approval tables or facts during an operational rollback.
