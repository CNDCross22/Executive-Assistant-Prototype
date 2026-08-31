# Hermes Security Specification

Version: 2.0 planning specification
Prepared: 31 August 2026

## Status legend

**CONFIRMED**: present in code/schema/tests. **INFERRED**: architectural conclusion without live verification. **PROPOSED**: required improvement. **REQUIRES VERIFICATION**: tenant/deployment/security review needed.

## 1. Current behaviour

**CONFIRMED** safeguards:

- Microsoft confidential-client OAuth with PKCE, configured tenant authority, token tenant validation, and primary/allowlisted email validation.
- Server-side Graph tokens, encrypted MSAL cache at rest, hashed opaque sessions, signed HTTP-only cookies, secure production cookies.
- Delegated `/me` Graph access with capability-scoped tool exposure.
- Fixed schema-validated tool registry; no arbitrary model-authored HTTP requests.
- All registered chat mutations use persisted, expiring, exact approvals bound to user and conversation.
- One pending action per conversation and atomic execution claim.
- Opaque Graph identifiers, plain-text email rendering, untrusted-content prompt framing, deterministic suspicion checks, claim guard, and output sanitisation.
- Safe Graph/database/model error mapping and secret/header/cookie log redaction.

**CONFIRMED** gaps:

- Direct Preferences mutations do not all use `action_approvals`, despite broad documentation wording.
- In-memory memory is not user-scoped.
- Suspicion and false-claim detection are heuristic.
- `audit_events` is not written.
- There are no attachment retrieval/extraction safeguards because attachment handling is not implemented.
- Live production scopes/configuration and migration state were not verified.

## 2. Proposed behaviour

**PROPOSED**: Preserve all current controls and add defence in depth around context, provenance, execution freshness, telemetry, background operation, and attachments.

Security invariants:

1. External content is data, never authority.
2. The model can propose only registered capabilities.
3. The server resolves identity, target, risk, and execution.
4. Consequential changes require a verified preview and explicit approval.
5. Execution success requires evidence; ambiguity remains unknown.
6. State is scoped to user, tenant, conversation/workflow, and exact action.
7. Logs and telemetry collect metadata needed for reliability, not content by default.

## 3. Reason for change

**PROPOSED rationale**: Richer context, proactive reads, attachment text, and more M365 services expand the untrusted-data and stale-state surface. Safety must become more typed and observable before capability expands. Removing approval to improve convenience is explicitly excluded.

## 4. Implementation approach

### 4.1 Untrusted-content provenance

Tag email, event description, contact note, task body, attachment extraction, Teams message, and document text with source type, source owner, retrieval time, and trust class. Preserve the tag through summarisation and fact extraction. Prompt construction places it only in data sections.

### 4.2 Approval freshness and receipts

Add target fingerprints based on material fields/version metadata. At execution, re-read where practical and compare. If recipient, time, ownership, or destructive target changed, expire and re-preview. Record attempt ID, confirmed result reference/time, known failure, or unknown outcome.

### 4.3 Prompt-injection controls

Retain regex signals but add structural isolation, bounded extraction schemas, tool-output trust annotations, and adversarial evaluation. Do not ask a model to decide whether its own instruction boundary should apply. Suspicious content can be analysed when the Director requests it but cannot author tool/policy/memory instructions.

### 4.4 Attachments

Phases:

1. Metadata only: name, type, size, inline flag, source.
2. Retrieval for an allowlist of file types and sizes.
3. Sandboxed text extraction with time/resource limits.
4. Untrusted-content summarisation.
5. Outgoing attachment inclusion from explicitly selected, approved sources.

Requirements include MIME/content validation, extension mismatch handling, size/decompression limits, malware scanning strategy, macro/archive policy, no execution, encrypted temporary storage, retention/deletion, and no silent forwarding.

### 4.5 New M365 services

Add one integration at a time. Each needs least-privilege delegated scopes, capability/tool metadata, read/write classification, preview, approval, failure semantics, logging, consent migration, and test tenant verification. Recommended order remains Teams, OneDrive/SharePoint, Planner, then selected Office document actions.

### 4.6 Privacy-first observability

Define event schemas and redaction tests. Record request/operation IDs, categories, durations, status, risk, model/cost counts, and source classifications. Do not record full message/document bodies, access/refresh tokens, secrets, cookies, raw headers, or arbitrary tool arguments.

## 5. Affected files

**PROPOSED**:

- Auth/session/MSAL/cache, Graph client/services/scopes.
- Agent prompt/context/registry/tool metadata/approvals/guards/sanitiser.
- Memory and conversation fallback stores.
- Logger/error mapping/telemetry modules.
- Attachment and future M365 service modules.
- Approval/notification UI, configuration, migrations, docs, security/adversarial tests.

## 6. Database changes

**PROPOSED**:

- Extend approvals with target fingerprint/version and receipt/attempt metadata.
- Wire privacy-safe audit events with explicit schema/version and retention.
- Add provenance/sensitivity/expiry to conversation facts and proactive events.
- Add attachment metadata only when needed; do not store raw files in ordinary relational fields.
- Add security-event metadata for injection/claim blocks without raw content.

**REQUIRES VERIFICATION**: Database encryption/backup policy, Supabase roles and row-level security, production network exposure, data residency/retention, and incident-response requirements.

## 7. API changes

**PROPOSED**:

- Structured action receipt and stale-target response states.
- Attachment metadata/content endpoints with authentication, size/type limits, and opaque references.
- No endpoints accepting raw Graph paths or arbitrary remote URLs.
- Consistent Preferences confirmation/audit semantics documented by risk.
- Admin/setup diagnostics reveal capability/scopes state without secrets.

## 8. Security implications

This entire document is security-impacting. Specific release rules:

- No write scope/capability is enabled before preview and approval tests exist.
- No background run occurs after user disable/revocation.
- No extracted content is promoted to memory or policy.
- No action retry occurs when the result is unknown.
- No model change is allowed to reduce tool restriction, validation, approval, or claim evidence.
- Single-user intent does not justify unsafe cross-user fallback state.

## 9. Cost implications

Security telemetry and scanning add storage/compute. Attachment malware scanning/extraction may require a service with separate cost/privacy review. Injection evaluation adds development model cost. These costs should be category-tracked. Security controls must not be disabled automatically because a model budget is exhausted; safe deterministic degradation takes precedence.

## 10. Failure cases

- Tenant or allowlist mismatch.
- Token cache decrypt failure or revoked consent.
- Cross-user cache/fact/approval collision.
- Novel prompt injection evades heuristic detection.
- Output sanitiser removes a warning or leaks an identifier.
- Target changes after preview.
- Graph returns an unknown mutation result.
- Malicious/polyglot/decompression-bomb attachment.
- Telemetry payload contains content or credentials.
- Background worker continues after policy disable.

Containment is deny mutation, preserve evidence, report plain uncertainty, and require reauthentication/re-preview where applicable.

## 11. Tests

**PROPOSED**:

- Tenant, allowlist, ownership, session, CSRF/cookie, and token-cache tests.
- Every tool schema/risk/capability invariant.
- Approval duplicate/expiry/revision/concurrency/stale-target/unknown-result tests.
- Injection corpus across mail, calendar, contact, task, attachment, Teams, and document text.
- Cross-user fallback/cache/database tests.
- Telemetry snapshot tests proving secret/content exclusion.
- Attachment MIME/size/archive/macro/malware-service failure tests.
- Dependency and scope review in CI; live read-only tenant smoke.

## 12. Acceptance criteria

- Existing security controls remain and are covered by regression tests.
- All state and caches are user-scoped.
- Every mutation has complete metadata, preview, approval, freshness policy, and receipt.
- External content provenance survives extraction and cannot alter instructions/memory/policy.
- Unknown outcomes are never reported as success/failure or blindly retried.
- Audit/telemetry are operational and privacy-allowlisted.
- New Graph scopes are enabled only with documented need and tests.
- Security review signs off before attachments, proactive operation, or new M365 writes.

## 13. Migration and rollback strategy

**PROPOSED**: Add user-scoping and telemetry redaction first. Add approval fingerprints/receipts per tool family behind flags. Run injection/adversarial suites before enabling richer context. Attachments begin metadata-only and can be disabled by capability flag. New Graph integrations use separate consent/capability flags. Rollback disables new reads/writes and returns to existing scopes/tool set; it never disables the original approval engine or deletes audit evidence.
