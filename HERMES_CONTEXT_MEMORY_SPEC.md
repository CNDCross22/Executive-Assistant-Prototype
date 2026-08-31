# Hermes Context and Memory Specification

Version: 2.0 planning specification
Prepared: 31 August 2026

## Phase 3 implementation update

**CONFIRMED**: The assistant route now supplies up to 200 stored messages to a deterministic context assembler. It selects the immediate exchange plus relevant older turns within 16-message and 12,000-character bounds, extracts up to six safe workflow summaries, and records content-free selection metrics. Stored approval cards do not become executable context; only the authoritative pending-approval record can supply revision state, which is labelled cancelled and not executed.

**CONFIRMED**: Memory now supports global, person, project, communication, calendar, email, and operational scopes with optional associations, confirmation time, expiry, conflict state, and supersession linkage. Exact scoped-key replacement archives only the exact predecessor. Specific applicable rules take precedence over broad rules without deleting them. Equal-scope opposing rules are withheld. Expired entries remain visible but are not recalled.

**CONFIRMED**: The process fallback is physically partitioned by user. The API and Preferences UI expose scope, association, source, confirmation, last use, expiry, and conflicts. Migration `0010_context_memory.sql` is additive apart from replacing the overly broad active-key index with a scope-aware index.

**REQUIRES VERIFICATION**: Recent workflow facts currently come from stored, sanitised step summaries rather than a dedicated fact table. Full executive project/entity context and semantic long-thread compaction remain later work. The application still manages Chat Completions history locally; Responses API state migration is separate.

## Status legend

**CONFIRMED**: current code/schema. **INFERRED**: not live-proven. **PROPOSED**: target. **REQUIRES VERIFICATION**: needs production data/operational validation.

## 1. Current behaviour

### Conversation context

**CONFIRMED**:

- Conversations are user-owned and durable when PostgreSQL is available.
- Up to 200 stored messages are supplied to a deterministic selector; at most 16 recent and relevant messages enter a model request.
- Current-turn tool results are available inside the model loop, but later turns receive visible conversation text and step summaries, not typed prior tool results.
- Pending approvals are durable and bound to user/conversation/exact tool arguments.
- Opaque M365 references can be restored across a preview and approval turn.

### Durable memory

**CONFIRMED**:

- Types: preference, person, working style, operational, procedural, and historical.
- Metadata already includes key, subject, importance, confidence, source, source reference, status, pinning, use count, last used, and optional expiry.
- Explicit supported statements create an approval card. Observed supported patterns remain inactive until approved.
- Retrieval uses PostgreSQL full-text search plus importance, pin, subject, and recency signals; at most ten active entries are inserted into the prompt.
- One active row per exact structured key is enforced; saving a replacement archives the former row.
- The in-memory fallback is partitioned by user ID.
- Expiry is enforced during retrieval and displayed in the UI; supported temporary language is parsed deterministically.

## 2. Proposed behaviour

### Layered context

**PROPOSED**:

1. Current request: exact Director message.
2. Active conversation: recent relevant turns, not a fixed blind slice.
3. Active action state: pending/revised/cancelled proposal, exact target class, preview, and prior decision.
4. Recent verified facts: compact tool-derived facts with source time and expiry.
5. Long-term memory: approved durable entries selected by relevance, scope, trust, and specificity.
6. Current executive context: supported people, projects, priorities, meetings, and unresolved matters assembled from verified data, never invented.

The model receives an explicit “not known” state rather than guessed continuity when selection fails.

### Memory semantics

**PROPOSED**:

- Scope values only where useful: global, person, project, communication, calendar, email, operational.
- Trust: explicit Director approval outranks approved observation; both outrank no memory. External content cannot create either.
- Specificity: a legal-email rule may override a general concise-email rule for legal emails without deleting the general rule.
- Temporality: temporary preferences require `expires_at`; expired entries are excluded and visibly marked.
- Provenance: UI shows why it is remembered, source class, confirmation time, last use, confidence, status, scope, and association.
- Conflict: detect exact-key replacement, overlapping scope, contradictory value, and duplicate semantics. Present the conflict before activation when deterministic resolution is unsafe.

## 3. Reason for change

**PROPOSED rationale**: Continuity is the defining experience of a private Executive Assistant, but raw history expansion creates privacy, relevance, and cost problems. Typed context reduces repetition while preserving evidence. Strong memory precedence prevents a broad old preference from corrupting a specific current task.

## 4. Implementation approach

### 4.1 Context contracts

Define typed `ContextItem` variants with `userId`, `conversationId` where applicable, type, text/value, provenance, source timestamp, confidence, sensitivity, expiry, and token estimate. Each layer has a selector and budget. Selection reasons and omissions are observable without storing content.

### 4.2 Recent facts

Store facts only when reuse is valuable. Examples: resolved person identity, selected message/thread reference, event reference and time, approved draft wording hash/body if the conversation already stores it, or a Graph read timestamp. Do not copy whole inboxes. Facts are data, never instructions, and cannot authorise a mutation.

### 4.3 Relevance and token budget

Select active action state first, then exact entity/reference matches, recent related turns/facts, applicable operational memories, specific preferences, and general history. Deduplicate repeated prose. Reserve space for tools and the answer. On ambiguity between two people or events, ask rather than choose by recency alone.

### 4.4 Memory precedence

Suggested ordering:

1. Safety and product policy, never memory-overridable.
2. Exact current Director instruction.
3. Active approved action state.
4. More specific approved memory over general approved memory.
5. Explicit approved memory over observed approved memory at equal specificity.
6. Higher confidence/importance and more recently confirmed at equal scope.

Conflicting equal-precedence memories are withheld and surfaced for review.

### 4.5 User-scoped fallback

Replace global fallback arrays with maps keyed by user ID. Apply the same user/conversation ownership checks as PostgreSQL. Clearly label fallback state as non-durable and disable risky learning if ownership cannot be established.

## 5. Affected files

**PROPOSED**:

- `agent/orchestrator.ts`, `agent/prompt.ts`, new `agent/context/*`.
- `conversations/store.ts`, assistant routes/shared contracts.
- `memory/store.ts`, `memory/explicit.ts`, `memory/learning.ts`, memory tools/routes.
- `pages/Assistant.tsx`, `pages/Memory.tsx`, API client/types.
- Migrations, docs, safety/integration/evaluation tests.

## 6. Database changes

**PROPOSED**:

- Add `scope` and optional `scope_ref` to `memory_entries` if `type/key/subject` cannot safely encode them.
- Add `last_confirmed_at`; reuse existing confidence, source, source_ref, expiry, status, use count, and subject.
- Add conflict/supersession linkage rather than deleting general rules.
- Add `conversation_facts` with user/conversation, fact type/value, source/provenance, timestamps, confidence, sensitivity, expiry, and supersession.
- Index user/status/scope/expiry and source references.

**REQUIRES VERIFICATION**: Existing rows, real key conventions, timezone treatment for expiry, retention, and whether historical memory should have different expiry rules.

## 7. API changes

**PROPOSED**:

- Memory responses add scope, source explanation, last confirmed/used, expiry, conflict, and explicit-versus-observed presentation.
- Create/edit requests can specify a validated expiry/scope; server derives trust source and never accepts arbitrary “explicit” claims from external content.
- Add conflict preview/resolve operations if needed.
- Chat response need not expose raw context; it may expose a simple clarification or “I no longer have enough context” statement.
- Align direct Preferences mutations with a documented, consistent confirmation policy without forcing every low-risk edit through chat.

## 8. Security implications

- Every memory/fact read and write is user-scoped, including in-memory fallback.
- Tenant/external content cannot write durable preferences or elevate confidence.
- Person/project scopes require normalized identifiers to prevent same-name contamination.
- Stored facts retain untrusted provenance and are never concatenated as system instructions.
- Memory UI does not expose raw Graph IDs.
- Deletion remains deliberate and auditable; expiry is not silent deletion.

## 9. Cost implications

**PROPOSED**: Deterministic metadata/full-text retrieval adds negligible model cost and may reduce repeated retrieval. A larger context can increase tokens, so enforce per-layer budgets. Do not add embeddings until keyword/scoped retrieval is evaluated and semantic benefit justifies a separately tracked embedding budget.

## 10. Failure cases

- Pronoun maps to the wrong entity.
- Old fact conflicts with current Graph state.
- A general memory incorrectly overrides a specific rule.
- Two equal-specificity memories conflict.
- Expiry timezone causes early/late application.
- Person names collide or a contact changes address.
- Database outage falls back to unscoped state.
- Context grows until it crowds out tools or answers.

Conservative response: withhold the uncertain item, re-read the source where safe, or ask a targeted clarification before any consequential action.

## 11. Tests

**PROPOSED**:

- “that meeting”, “send it to her”, “same wording”, “move it to tomorrow”.
- Pending action revision and cancellation after intervening requests.
- Long conversations with relevant old turn and irrelevant recent turns.
- Fact expiry, supersession, source deletion, and Graph revalidation.
- Explicit/inferred memory, approval/dismissal, conflict, specificity, expiry, retrieval, wrong-memory prevention.
- Same name across people/projects, cross-person contamination, cross-user isolation, and database-free fallback.
- Prompt-injection content cannot become memory or active context instruction.

## 12. Acceptance criteria

- Relevant references resolve across long conversations when evidence is unambiguous.
- Pending action state is always included and cannot be confused with completed action.
- No mutation executes from a stored fact without preview and fresh target validation.
- Memory conflicts resolve by documented precedence or require review.
- Expired memory never influences prompts and remains visible in history.
- All fallback memory is user-scoped.
- Context token budgets and selection telemetry are measurable.
- Tests demonstrate no cross-user/person/project leakage.

## 13. Migration and rollback strategy

**PROPOSED**:

1. Add nullable metadata/fact tables and backfill existing active memories as global scope with `last_confirmed_at = created_at` only when semantically safe.
2. Dual-read old and new fields; continue current retrieval ranking as fallback.
3. Run context selection in shadow mode and compare chosen items.
4. Enable active action and exact-reference layers first, then facts, then scoped memory.
5. Enable conflict/expiry UI after backend rules are stable.

Rollback disables new selectors and ignores additive columns/facts. Do not delete migrated memory. Restore current ten-memory/eight-turn prompt behaviour while retaining ownership fixes.
