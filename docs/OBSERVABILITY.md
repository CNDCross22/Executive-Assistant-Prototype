# Observability

Hermes records enough metadata to diagnose reliability, safety, latency and cost without turning logs into a second mailbox.

## Correlation

Every assistant HTTP request receives a Fastify request ID. Each assistant or briefing run also receives a new workflow ID. The IDs correlate:

- request completion or failure;
- model calls and iterations;
- tool calls and failures;
- approval creation, cancellation, supersession and execution;
- bounded conversation-context assembly, including candidate and selected counts;
- memory retrieval and proposal creation;
- suspicious-content and false-action blocks;
- briefing generation;
- token usage and calculated cost.

Conversation, model role, response mode, purpose and budget category are included where applicable. Internal mode and role names are diagnostic metadata, not Director-facing language.

## Privacy boundary

`safeTelemetryPayload()` copies only an explicit field allowlist. Arbitrary objects are discarded at runtime even if a caller bypasses TypeScript.

Telemetry does not accept:

- email, calendar, contact, task or attachment bodies;
- tool arguments or approval previews;
- Graph identifiers from tool results;
- access tokens, refresh tokens, API keys or client secrets;
- cookies or raw authorisation headers;
- user-entered search strings or full request URLs.

Pino retains its independent redaction rules. Request URLs are stored without query strings.

## Storage

Structured events are written to the existing `audit_events` table when PostgreSQL is available. Persistence failures are logged and do not turn a successful Director request into a failure. Model usage and exact micro-dollar cost remain in `ai_usage`.

Migration `0009_phase1_foundation.sql` adds request, conversation, workflow, model-role, response-mode, iteration and budget-category attribution to `ai_usage`. Existing rows remain valid.

Migration `0010_context_memory.sql` adds scoped-memory lifecycle fields and supporting indexes. Context telemetry records counts and estimated size only; it never records selected conversation text or memory content.

Migration `0011_proactive_engine.sql` adds proactive run and delivery receipts. Proactive telemetry records scan duration, trigger count, and a bounded reason code. It does not log source text, Microsoft identifiers, access tokens, or message bodies. Detailed evidence is user-scoped application state, not log payload.

## Operating rules

- Use IDs and bounded categorical fields to investigate an issue, then reproduce with synthetic data.
- Do not add arbitrary `detail` objects to telemetry calls.
- Do not log provider request/response bodies.
- Preserve confirmed Graph success even if telemetry persistence fails.
- Treat an unknown mutation outcome as unknown and never retry it blindly.
