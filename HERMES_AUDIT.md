# Hermes Executive Assistant: Phase 0 Audit

Version: 2.0 planning baseline
Prepared: 31 August 2026
Scope: Repository inspection and planning only. No application behaviour is changed by this document.

## Status legend

- **CONFIRMED**: Demonstrated by current source, configuration, schema, or a test executed against this worktree.
- **INFERRED**: Strongly suggested by the implementation, but not proven against live Microsoft 365, OpenAI, or production infrastructure.
- **PROPOSED**: A target design, not current behaviour.
- **REQUIRES VERIFICATION**: Must be checked in the target tenant, account, deployment, or live API before implementation or release.

## 1. Audit scope and evidence

**CONFIRMED**: The audit covers every application file returned by `rg --files`, including the API, web client, shared package, eight database migrations, root configuration, prompt/persona files, test suite, and the four existing technical documents. The detailed current-behaviour baseline is in `EXECUTIVE_ASSISTANT_BEHAVIOUR_REPORT.txt`.

**CONFIRMED** evidence reviewed:

- Root and workspace package manifests and lockfile.
- `soul.md`, `agent/soul.ts`, `agent/persona.ts`, `agent/prompt.ts`, and `agent/skills.ts`.
- The orchestrator, deterministic fast paths, guards, sanitiser, references, approval engine, registry, and all registered tool modules.
- Microsoft Graph client and mail, calendar, contacts, tasks, directory, profile, and mailbox-settings services.
- Authentication, session, encrypted token cache, tenant/user restrictions, error mapping, and logging.
- Memory store, explicit-memory parser, observation system, routes, database schema, and Preferences UI.
- Dashboard, briefing generation, Assistant UI, approval cards, and conversation persistence.
- `docs/AI_AGENT.md`, `docs/MEMORY.md`, `docs/SECURITY.md`, and `docs/MICROSOFT_GRAPH.md`.
- The single automated test file and development harnesses.
- Official current OpenAI model and API documentation, plus the installed OpenAI Node SDK surface.

**CONFIRMED** validation at this baseline:

- `npm.cmd test`: 97 passed, 0 failed, 0 skipped.
- `npm.cmd run typecheck`: API, web, and shared workspaces passed.
- The repository had substantial pre-existing uncommitted work before these planning files were added. Those changes were treated as the current implementation and were not overwritten.

**REQUIRES VERIFICATION**:

- The local API was not running during the baseline check.
- Live Microsoft Graph connectivity, granted tenant scopes, OpenAI account model access, database migration state, production configuration, and browser end-to-end behaviour were not exercised.
- The tests are strong safety-oriented unit tests, but the passing count does not prove live integration or production readiness.

## 2. Architecture map

### 2.1 Runtime topology

**CONFIRMED**:

```text
React web client
  -> authenticated Fastify API
      -> conversation and approval stores -> PostgreSQL/Supabase
      -> orchestrator
          -> deterministic approval/rejection handling
          -> explicit memory parser and observation
          -> deterministic inbox fast paths
          -> memory retrieval and prompt assembly
          -> skill selection and restricted tool exposure
          -> OpenAI Chat Completions loop
          -> schema-validated tool registry
              -> read tools execute immediately
              -> mutation tools create persisted approval previews
              -> approved mutations execute exactly once
          -> claim guard and output sanitiser
      -> Microsoft Graph client -> delegated `/me` endpoints
```

### 2.2 Dependency map

**CONFIRMED**:

| Layer | Primary files | Depends on | Owns |
|---|---|---|---|
| Web shell | `apps/web/src/App.tsx`, `pages/Workspace.tsx` | React Query, API client | Authenticated navigation and refresh behaviour |
| Assistant UI | `pages/Assistant.tsx`, `components/Message.tsx` | Conversation API, approval presentation | Conversation display, composer, approval decisions |
| Dashboard and briefing UI | `pages/Dashboard.tsx`, `pages/Briefing.tsx` | Dashboard endpoints | Deterministic work view and generated morning note |
| HTTP boundary | `apps/api/src/routes/*.ts`, `index.ts` | Fastify, Zod, session middleware | Request validation, ownership, response mapping |
| Agent runtime | `agent/orchestrator.ts` | prompt, skills, memory, provider, registry, approvals | Bounded decision and tool loop |
| Trust boundary | `agent/registry.ts`, `agent/approvals.ts`, `agent/guards.ts`, `agent/sanitise.ts`, `agent/refs.ts` | Tool schemas and stores | Validation, approval, exact execution, claim truth, ID hiding |
| Model adapter | `ai/provider.ts`, `ai/openai.ts`, `ai/cost.ts` | OpenAI SDK, usage store | Chat completion translation, token/cost accounting, budget stop |
| M365 services | `graph/*.service.ts`, `graph/client.ts` | Microsoft Graph | Typed operations, retry and failure mapping |
| Executive data | `mail/triage.ts`, `mail/suspicion.ts`, `dashboard/*` | Mail service, memory | Deterministic scoring, follow-ups, suspicion, briefings |
| Durable state | `conversations/store.ts`, `memory/*`, `auth/*`, migrations | PostgreSQL/Supabase | Sessions, conversations, approvals, memory, usage |
| Shared contracts | `packages/shared/src/index.ts`, web API types | API and web | Cross-workspace types |

### 2.3 Agent flow

**CONFIRMED**:

1. The route validates a 1 to 4,000 character message and resolves a user-owned conversation.
2. It stores the user message, builds Graph-backed services, and calls the orchestrator.
3. The orchestrator handles exact approval/rejection before any model call.
4. An intervening non-decision message supersedes the current proposal; a recognised revision can replace it.
5. Deterministic explicit-memory parsing can create a memory approval without model interpretation.
6. Narrow regex observations are accumulated; a third observation can create an inactive proposal.
7. A first-turn short, single-purpose inbox question may use a zero-cost deterministic fast path.
8. Up to ten active memories are retrieved.
9. At most two request-specific skills, plus always-on memory and suspicious-content skills, determine the exposed tools.
10. The model receives recent conversation text, the system prompt, and only relevant tool schemas.
11. The loop runs for at most six iterations and 180 seconds.
12. Read tools run immediately. Every registry mutation is converted into a persisted 15-minute preview.
13. A later standalone approval atomically claims and executes the saved exact tool arguments.
14. Unsupported action claims and internal workflow narration are blocked; the response is sanitised and persisted.

### 2.4 Prompt flow

**CONFIRMED**: `soul.md` is the authoritative hot-reloaded behaviour contract. `agent/persona.ts` is a fallback. `agent/prompt.ts` adds current identity, timezone, relevant memory, selected skills, capabilities, trust hierarchy, untrusted-data rules, and action constraints. Tool descriptions are supplied separately by the provider.

**CONFIRMED**: The current design relies on prompt prose for several presentation qualities that are not represented as structured state, including response type, adaptive length, tactful disagreement, and executive recommendation format.

### 2.5 Approval flow

**CONFIRMED**:

```text
validated mutation request
  -> resolve current target and build Director-facing preview
  -> persist exact tool + arguments + preview + user + conversation + expiry
  -> return approval card
  -> exact standalone Yes
  -> atomic pending -> executing claim
  -> revalidate tool arguments
  -> execute once
  -> record executed/failed and return evidence-backed receipt
```

The engine allows one pending action per user/conversation, expires proposals after 15 minutes, rejects ambiguous approvals, restores opaque reference state across approval turns, and treats ambiguous Graph mutation transport failures as unknown outcomes rather than definite failure.

### 2.6 Memory flow

**CONFIRMED**:

```text
explicit Director statement -> deterministic parser -> approval -> active memory
repeated supported pattern -> signal count -> inactive proposal -> UI approval -> active memory
active memory -> keyword/importance retrieval -> up to 10 prompt entries -> use count update
```

The schema already contains type, key, subject, importance, confidence, source, source reference, status, pinning, use count, last-used time, and optional expiry. PostgreSQL full-text search is used; embeddings are not.

### 2.7 Briefing flow

**CONFIRMED**: The dashboard deterministically builds priority messages, follow-ups, unread totals, calendar items, tasks, memory proposals, and service notices. The briefing serialises a bounded snapshot, adds the soul, asks the single configured model for a maximum 500-token note, sanitises it, and caches it for 20 minutes with a three-minute minimum refresh interval. The dashboard remains useful if model generation fails.

## 3. Current behaviour inventory

### 3.1 Model and context

**CONFIRMED**:

- Production calls use OpenAI Chat Completions via `openai` npm package 7.5.0.
- `OPENAI_MODEL` defaults to and is currently configured as `gpt-5-mini`.
- GPT-5 requests use `max_completion_tokens`, omit temperature, and force `reasoning_effort: "minimal"`.
- General chat is capped at 800 completion tokens; briefing is capped at 500.
- The API client timeout is 180 seconds with two retries. The agent is bounded to six iterations and 180 seconds.
- The conversation store can return up to 200 messages, but only the most recent eight user/assistant turns are supplied as model context.
- Detailed prior tool results are not stored as replayable facts. Later turns generally need to retrieve the M365 object again.

### 3.2 Tool inventory

**CONFIRMED**: 38 tools are registered: 16 read-only and 22 mutating.

| Risk | Count | Behaviour | Tools |
|---|---:|---|---|
| 0 | 16 | Executes immediately | `calendar_list`, `contacts_search`, `directory_search`, `mail_follow_ups`, `mail_list_folders`, `mail_needs_attention`, `mail_read`, `mail_recent`, `mail_search`, `mailbox_settings_read`, `memory_list`, `memory_recall`, `people_search`, `profile_read`, `task_lists`, `tasks_list` |
| 1 | 7 | Preview and approval | `mail_change_state`, `mail_create_draft`, `mail_create_reply_draft`, `mail_move`, `memory_remember`, `task_create`, `task_update` |
| 2 | 10 | Preview and approval | `calendar_create`, `calendar_respond`, `calendar_update`, `contact_create`, `contact_update`, `mail_forward`, `mail_reply`, `mail_send`, `mail_send_draft`, `mailbox_settings_update` |
| 3 | 5 | Destructive preview and approval | `calendar_delete`, `contact_delete`, `mail_delete`, `task_delete`, `memory_forget` |

**CONFIRMED**: Tool schemas are Zod-derived, the model cannot submit arbitrary Graph URLs, and only capability-enabled tools selected by the skill router are exposed.

### 3.3 Executive data behaviour

**CONFIRMED**:

- Inbox triage is deterministic, bounded to up to 100 inbox messages in the prior 72 hours plus 100 sent messages for relationship/thread signals.
- Scoring uses directness, CC status, prior correspondent/thread participation, unread/importance/age/recency, external sender, automation, and recipient count.
- Follow-up detection compares bounded inbox/sent windows and uses a minimum waiting period.
- The current system has email search and summaries, but no structured extraction record for request, decision, commitment, deadline evidence, unanswered questions, or risk.
- Calendar support covers list/create/update/delete/respond with timezone conversion and directory resolution. It has no recurrence schema, dedicated free/busy endpoint, or negotiation workflow.
- Attachment metadata is exposed through `hasAttachments`; attachment listing, retrieval, extraction, summarisation, and adding new attachments are absent. Forwarding preserves the original email's attachments.

### 3.4 Security and identity

**CONFIRMED**:

- Server-side Microsoft OAuth uses PKCE, a tenant lock, and an email allowlist.
- Session cookies are signed, HTTP-only, SameSite=Lax, and Secure in production; only hashed opaque session tokens are stored.
- The MSAL token cache is encrypted at rest and Graph tokens do not reach the browser.
- Graph uses delegated `/me` permissions.
- Retrieved external text is labelled untrusted; email HTML becomes plain text before browser rendering.
- Deterministic suspicion detection and false-action claim detection are heuristic regex systems backed by approval and execution evidence.
- Logs redact cookies, authorisation headers, access/refresh tokens, and client secrets; URLs are logged without query strings.

## 4. Contradictions and documentation mismatches

1. **CONFIRMED**: `docs/MEMORY.md` says an explicit statement is saved immediately. Current chat behaviour creates a risk-1 approval and activates it only after Yes.
2. **CONFIRMED**: `soul.md` discusses recurrence details in calendar previews, but no calendar tool schema supports recurrence.
3. **CONFIRMED**: `docs/SECURITY.md` says all mutations require persisted approval. This is true for registered chat tools, but Preferences-page create/edit/approve/dismiss endpoints write directly; deletion uses UI confirmation rather than `action_approvals`.
4. **CONFIRMED**: The database comments and memory documentation describe database-backed `skills` as procedures that can extend or override built-ins. No runtime code queries the `skills` table.
5. **CONFIRMED**: The foundation migration describes `audit_events` as recording every assistant action. No application code reads or writes that table.
6. **CONFIRMED**: The personality contract supports substantial reports, but the universal 800-token chat ceiling can prevent them.
7. **CONFIRMED**: The configuration and documentation expose one `OPENAI_MODEL`; the new specification requires purpose-aware model policy, which does not yet exist.

## 5. Dead code, duplication, and weak abstractions

### 5.1 Confirmed unwired or misleading elements

- **CONFIRMED**: `audit_events` is an unwired schema feature. It creates an expectation of action auditing that the runtime does not fulfil.
- **CONFIRMED**: the `skills` table is unwired. The runtime uses only built-in TypeScript skills.
- **CONFIRMED**: `refresh_token_encrypted` remains in schema/store compatibility code while the encrypted full MSAL token cache is the active design. Its necessity should be verified before any removal.
- **CONFIRMED**: the configured chat `temperature: 0.3` does not affect GPT-5-family requests because the provider intentionally omits it.

### 5.2 Duplicated or fragmented policy

- **INFERRED**: Behaviour policy is distributed across `soul.md`, fallback persona, prompt, skills, sanitiser regexes, claim guard regexes, briefing prompt, and UI copy. This makes contradictions likely even when each component is locally reasonable.
- **CONFIRMED**: response length is selected at individual call sites rather than through a policy abstraction.
- **CONFIRMED**: model selection is global while usage purpose is recorded separately. The system already knows `chat` versus `briefing`, but cannot use that distinction for model or budget policy.
- **CONFIRMED**: action risk, capability, schema, execution, and preview are attached to each tool, but category, mutation semantics, idempotency, stale-target policy, and receipt requirements are not represented uniformly.
- **INFERRED**: memory keys prevent two active values for the same exact key, but do not express precedence between a general rule and a more specific contextual exception.

### 5.3 Safety-significant weaknesses

- **CONFIRMED**: in-memory memory entries are not partitioned by user. This is acceptable only for the intended single-user development posture and must not remain if multiple users can access a database-free process.
- **CONFIRMED**: detailed tool results vanish from future prompt context except for visible prose and step summaries. This weakens references such as “use the same wording” and can cause repeated reads.
- **CONFIRMED**: observed-memory proposal creation is not announced in the same assistant turn; it appears later on Dashboard/Preferences.
- **CONFIRMED**: fast paths work only on the first conversation turn, creating inconsistent performance and wording for identical later questions.
- **INFERRED**: regex suspicion and claim checks remain bypassable by novel wording. The deterministic approval boundary limits impact but does not make interpretation perfect.

## 6. Proposed behaviour and reason for change

**PROPOSED**: Preserve the deterministic trust boundary and evolve Hermes around it:

1. Add a layered, relevance-selected context assembler with active action state and compact verified facts.
2. Add purpose-aware model and response policy, retaining the current model as fallback until evaluations show a safe quality gain.
3. Add structured executive analysis over a deterministic shortlist, with deadline evidence and calendar conflict checks.
4. Complete the existing memory design with scope, precedence, expiry enforcement, provenance, and user-safe fallback behaviour.
5. Add action receipts, stale-target checks, privacy-first telemetry, and behavioural/integration/e2e tests before proactive operation.

The reason is user value, not architectural fashion: Hermes should require less repetition, make clearer recommendations, preserve exact action truth, and remain useful under budget or service failure.

## 7. Five highest-impact changes

### 7.1 Layered context and verified working state

**PROPOSED**

- Why it matters: Forgetting the active subject or losing prior tool facts is the most direct barrier to feeling like a competent Executive Assistant.
- User benefit: “Send it to her”, “move that meeting”, and “use the same wording” can be resolved from explicit recent state without dumping full history into the model.
- Complexity: High. Requires context selection, fact lifecycle, reference provenance, token budgeting, and tests across multiple turns.
- Risk: Stale or cross-subject facts could target the wrong person/action. Mitigate with typed provenance, user/conversation binding, expiry, and re-resolution before mutation.
- Cost impact: Usually lower repeated Graph/model work; modest prompt cost if selection is disciplined.
- Affected files: `agent/orchestrator.ts`, new `agent/context/*`, `agent/prompt.ts`, `conversations/store.ts`, shared/API types, migrations, Assistant routes/tests.
- Tests: pronoun/reference fixtures, pending revisions, tool continuation, long conversations, stale facts, cross-user isolation.
- Migration: additive fact/context tables behind a feature flag; fall back to current eight-turn flow; no destructive rollback.

### 7.2 Purpose-aware model and response policy

**PROPOSED**

- Why it matters: One minimally reasoning model and one short ceiling cannot optimise simple counts, sensitive drafts, complex planning, and briefings simultaneously.
- User benefit: Faster routine answers, better judgement on complex work, and enough space for useful reports without making every answer long.
- Complexity: Medium to high. Model/API compatibility, policy routing, per-mode limits, cost attribution, and evaluation are required.
- Risk: cost growth, latency, unsupported account model, response drift, or tool-call regressions.
- Cost impact: Controlled by role budgets, hard caps, canarying, and deterministic fallbacks. No production default changes until measured.
- Affected files: `config/env.ts`, `ai/provider.ts`, `ai/openai.ts`, `ai/cost.ts`, `ai/index.ts`, `agent/orchestrator.ts`, `dashboard/briefing.ts`, setup/status routes, docs/tests.
- Tests: payload compatibility, policy selection, budget categories, fallback, tool calling, latency/cost evaluation.
- Migration: support legacy `OPENAI_MODEL`; shadow/evaluation first; reversible per-role feature flag.

### 7.3 Structured executive intelligence and briefing

**PROPOSED**

- Why it matters: Deterministic triage is transparent but does not understand requests, decisions, consequences, dependencies, or deadline evidence.
- User benefit: Briefings answer what matters, why, what to do, what changed, and what can wait.
- Complexity: High. Requires normalized evidence, thread retrieval, calendar conflicts, shortlist analysis, and quality evaluation.
- Risk: model-generated urgency or deadlines. Deterministic source evidence must remain attached and unsupported precise deadlines forbidden.
- Cost impact: Moderate if only top-ranked items are interpreted; high if the whole mailbox is model-analysed.
- Affected files: `mail/triage.ts`, `graph/mail.service.ts`, `graph/calendar.service.ts`, `dashboard/service.ts`, `dashboard/briefing.ts`, new executive-analysis modules, UI/tests.
- Tests: realistic threads, deadline absent/present, owed responses, conflicting appointments, no-urgent-items briefing.
- Migration: retain current score and dashboard; add semantic annotations behind a flag; remove only if evaluation and cost gates fail.

### 7.4 Trustworthy scoped memory

**PROPOSED**

- Why it matters: Useful memory reduces repetition, but incorrect or overgeneral memory silently corrupts future advice.
- User benefit: General preferences coexist with specific exceptions; temporary instructions expire; the Director can see origin and confidence.
- Complexity: High due to precedence, conflict detection, expiry, UI explanations, and legacy rows.
- Risk: wrong-memory application and privacy leakage. Default to exclusion on ambiguity; never promote external content.
- Cost impact: Low for deterministic metadata/full-text retrieval; optional semantic retrieval must have a separate budget.
- Affected files: migrations, `memory/*`, `agent/prompt.ts`, `routes/memory.routes.ts`, `pages/Memory.tsx`, shared types/tests.
- Tests: explicit/inferred approval, conflict, expiry, retrieval, person/project isolation, cross-user fallback.
- Migration: nullable/additive columns; derive safe global scope for existing rows; dual-read; rollback ignores new metadata.

### 7.5 Approval hardening, receipts, and observability

**PROPOSED**

- Why it matters: Approval is Hermes’s strongest control. Better previews, target version checks, uncertain-result receipts, and telemetry improve reliability without granting autonomy.
- User benefit: The Director sees exactly what will happen and gets a durable, truthful result.
- Complexity: Medium to high across all mutation tools and UI.
- Risk: over-logging sensitive content or introducing concurrency bugs. Use metadata-only telemetry and transactional claims.
- Cost impact: Low model cost; modest database/storage and operational telemetry cost.
- Affected files: `agent/approvals.ts`, `agent/registry.ts`, all mutating tools, Graph services, `components/Message.tsx`, migrations, logger/tests.
- Tests: duplicate/expired approval, revisions, changed recipient/time/target, concurrent claim, stale target, confirmed/failed/unknown execution.
- Migration: additive approval version/receipt fields; retain current engine; feature-flag stale checks by tool; rollback uses existing records.

## 8. Implementation approach and sequence

**PROPOSED** order:

1. Foundation contracts: model policy interfaces, response modes, typed tool metadata, request IDs, telemetry event schema, and feature flags. No behaviour change by default.
2. Context assembler: active action state, relevant turns, verified facts, token budgets, and safe fallback.
3. Humanisation: revised soul, response-mode policies, adaptive limits, briefing renderer, and 100-case evaluation corpus.
4. Memory: scoped/conflict-aware retrieval, provenance display, expiry enforcement, and user-scoped fallback.
5. Executive intelligence: deterministic shortlist plus semantic evidence extraction, thread-aware recommendations, and calendar conflicts.
6. Approval and failure hardening: complete previews, target fingerprints, durable receipts, unknown-outcome workflow.
7. Proactive engine in notify/recommend-only mode, only after observability and evaluations meet release gates.
8. Attachments and additional M365 services in independently consented, least-privilege phases.

## 9. Affected files

**PROPOSED**: The focused specifications list exact files. The cross-cutting core is expected to include:

- Existing: `apps/api/src/agent/*`, `apps/api/src/ai/*`, `apps/api/src/memory/*`, `apps/api/src/dashboard/*`, `apps/api/src/graph/*`, route files, shared contracts, Assistant/Dashboard/Briefing/Memory UI, `.env.example`, docs, tests, and migrations.
- New conceptual modules: `agent/context`, `agent/response-policy`, `agent/executive`, `telemetry`, `proactive`, and evaluation fixtures/runners.
- **REQUIRES VERIFICATION**: Final names should follow the existing repository style during implementation; no empty architectural layer should be added merely to match this plan.

## 10. Database changes

**PROPOSED** additive changes only:

- Extend `ai_usage` with request, conversation, workflow, and policy-role identifiers or add a related usage-attribution table.
- Add verified conversation facts with user/conversation ownership, provenance, sensitivity, expiry, and source reference.
- Extend memory with explicit scope and last-confirmed metadata if the existing key/subject fields cannot represent them safely.
- Extend approvals with target fingerprint/version and structured execution receipt.
- Wire `audit_events` or replace it through a documented migration if a better immutable event table is chosen.
- Add proactive policy/event/notification tables only in Phase 5.

**REQUIRES VERIFICATION**: Existing production migration state, row volume, retention requirements, Supabase backup/restore, and whether row-level security is used outside this codebase.

## 11. API changes

**PROPOSED**:

- Preserve current endpoints and response shapes during early phases.
- Add optional response metadata for mode, verified facts, action receipt, and degraded state without exposing internal model/tool names to the Director.
- Expand setup/status for per-role model configuration and category budgets, with secrets excluded.
- Expand memory endpoints with provenance/scope/expiry and consistent confirmation semantics.
- Add proactive policy and notification endpoints only after the engine exists.
- Version any breaking contract; update shared and web types in the same change.

## 12. Security implications

**CONFIRMED**: The current approval engine, tenant validation, allowlist, server-side tokens, encrypted cache, opaque IDs, plain-text rendering, suspicious-content treatment, output sanitisation, and safe errors must remain.

**PROPOSED**:

- Treat every stored verified fact as tainted by its source and never convert external content into an instruction.
- Re-resolve and fingerprint mutation targets at approval and execution.
- Keep proactive output at notify, recommend, or prepare-draft levels; no externally visible mutation without the same approval engine.
- Add privacy classifications and allowlisted telemetry fields.
- Scope all fallbacks and caches by user, tenant, and conversation as applicable.

## 13. Cost implications

**CONFIRMED**: Current accounting records provider, model, purpose, token counts, duration, and micro-dollar cost, with a USD 5 monthly hard stop.

**PROPOSED**:

- Retain exact micro-dollar accounting and pessimistic pricing for unknown models.
- Attribute spend by request, conversation, model role, briefing, evaluation, and future background work.
- Add independent category caps so background work cannot consume interactive capacity.
- Use deterministic shortlist/filtering before model interpretation.
- Treat current official pricing as time-sensitive configuration data, not a permanent constant.

## 14. Failure cases

Key cases that implementation must design before coding:

- Context selects the wrong person, event, draft, or prior result.
- A fact becomes stale between read, preview, approval, and execution.
- Model role is unavailable, times out, or exceeds category/monthly budget.
- Responses API migration changes tool-call semantics or token reporting.
- A memory exception incorrectly overrides a general rule, or vice versa.
- The model invents a deadline, completion, or priority without evidence.
- Graph returns 429, 5xx, timeout, or an ambiguous mutation result.
- A duplicate or concurrent approval reaches execution.
- A proactive job runs twice, runs late, crosses user boundaries, or creates notification fatigue.
- Telemetry accidentally captures email bodies, tokens, secrets, or raw authorisation data.

## 15. Test plan summary

**PROPOSED**:

- Unit: parsers, context selection, evidence schemas, memory precedence/expiry, tool metadata, approval state machine, sanitisation, cost and policy routing.
- Integration: orchestrator plus fake provider, approval store, Graph mock, conversation facts, memory, dashboard, and migrations.
- End-to-end: request through preview, approval, exact mutation, receipt, refresh, duplicate decision, and unknown outcome.
- Behavioural: at least 100 versioned executive scenarios scored for accuracy, naturalness, brevity, context, professionalism, cliché avoidance, dash use, action truth, approval, and recommendation.
- Live read-only smoke: tenant-scoped profile, mail, calendar, contacts, people/directory, mailbox settings, and tasks.
- Mutation smoke: separate test mailbox/tenant only, manually gated, never the Director’s production mailbox.

## 16. Acceptance criteria

Phase 0 is accepted when:

- All eleven required planning documents exist and contain the required impact sections.
- Every material current-state statement is marked confirmed, inferred, proposed, or requiring verification.
- Architecture, agent, prompt, tool, memory, approval, briefing, auth, Graph, test, and documentation flows are mapped.
- Contradictions and unwired schema features are recorded.
- The five highest-impact changes include benefit, complexity, risk, cost, files, tests, and migration.
- The proposed sequence preserves approval and does not claim untested features work.
- No application code or database behaviour is changed during Phase 0.

## 17. Migration and rollback strategy

**PROPOSED**:

- Use additive migrations, backward-compatible API fields, and feature flags.
- Capture the 97-test baseline and behavioural corpus before changing prompts or providers.
- Introduce one policy or data path at a time with current behaviour as the fallback.
- Shadow or evaluate model/context changes before enabling them for live actions.
- Keep approval execution on the existing deterministic engine throughout migration.
- Roll back by disabling feature flags and returning to legacy environment variables/read paths; do not require destructive schema rollback.
- Never roll back by deleting new evidence or audit records. Retain them until an explicit, tested retention migration exists.

## 18. Audit conclusion

**CONFIRMED**: Hermes is currently a conservative, reactive Microsoft 365 assistant with unusually strong mutation controls and a clear model-versus-code trust boundary. Its most important limitations are context continuity, coarse model/response policy, heuristic executive interpretation, incomplete memory semantics, and limited integration/evaluation coverage.

**PROPOSED**: The correct path is evolutionary. Preserve deterministic ranking and approval, add typed evidence and context, measure model changes, then introduce proactive recommendations only after observability and failure controls exist. Hermes should become more capable by understanding state and consequences, not by receiving broader authority.
