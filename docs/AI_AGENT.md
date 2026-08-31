# OpenAI agent runtime

The application has one model integration: the official OpenAI API. Development is performed with Codex; production model calls use the API credits attached to `OPENAI_API_KEY`.

## Configuration

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6-luna
OPENAI_FAST_MODEL=gpt-5.6-luna
OPENAI_EXECUTIVE_MODEL=gpt-5.6-sol
OPENAI_BRIEFING_MODEL=gpt-5.6-luna
OPENAI_BACKGROUND_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=none
OPENAI_FAST_REASONING_EFFORT=none
OPENAI_EXECUTIVE_REASONING_EFFORT=low
OPENAI_BRIEFING_REASONING_EFFORT=low
OPENAI_BACKGROUND_REASONING_EFFORT=none
OPENAI_SERVICE_TIER=default
OPENAI_FAST_SERVICE_TIER=default
OPENAI_EXECUTIVE_SERVICE_TIER=fast
OPENAI_BRIEFING_SERVICE_TIER=default
OPENAI_BACKGROUND_SERVICE_TIER=default
OPENAI_MONTHLY_BUDGET_USD=5
OPENAI_INTERACTIVE_BUDGET_USD=4.5
OPENAI_BRIEFING_BUDGET_USD=0.5
OPENAI_BACKGROUND_BUDGET_USD=0
HERMES_RESPONSE_MODES=true
```

Create the key at https://platform.openai.com/api-keys and keep it on the API server. Never expose it through a `VITE_` environment variable, browser code, example file, log, or commit.

The production policy uses Luna for routine, briefing, and reserved background work, and Sol for executive, drafting, and sensitive work. Sol uses low reasoning with Fast processing. Routine Luna calls use standard processing. The background budget remains zero, so no background model call can consume the monthly allowance. Adaptive response limits are enabled, but remain ceilings rather than length targets.

Each turn receives a compact response contract for its selected mode. The contract controls answer shape and typical length only; it cannot grant tools, lower risk, or approve an action. Adaptive token limits remain disabled by default until model-backed evaluation demonstrates a quality and cost benefit.

Restart the API after changing configuration. `GET /api/setup` reports the effective role policy, and `GET /api/assistant/status` checks the executive/default model available to the account.

Hermes uses the Responses API for every model role. Requests use `store: false`; encrypted reasoning items are carried only inside the current in-memory tool loop and are not written to the conversation database or logs. This permits Sol reasoning with function tools while keeping Hermes-owned bounded context and the existing approval architecture. See the [official Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## Phase 1 policy layer

Every model call now has an internal response mode and model role. Modes choose presentation policy and a completion ceiling. Roles choose the configured model, reasoning effort and budget category. Neither can grant a tool, change a risk level or bypass approval.

Current roles are `fast`, `executive`, `briefing` and reserved `background`. Current response modes are direct, executive, draft, action preview/result, error, sensitive and briefing. These names are internal and are not shown in normal Director-facing replies.

## Request path

1. `tryFastPath()` answers deterministic questions without spending API credits.
2. Relevant approved memories and Microsoft 365 tool definitions are added to the prompt.
3. A deterministic response policy and purpose-based model policy are selected. Any unresolved consequential action is prepared with the executive model, even when the latest clarification is short.
4. The bounded orchestrator calls OpenAI and validates every requested tool.
5. Read operations execute immediately. Changes resolve their exact target and create a complete, expiring preview.
6. The preview is persisted with the chat and remains an interactive card after a page refresh.
7. A standalone, unambiguous approval atomically executes the saved action once; a rejection cancels it.
8. Any intervening message supersedes the pending action, and only one action may be pending in a conversation.
9. `checkClaims()` blocks claims of actions that were not actually performed.
10. The sanitized answer, usage attribution and privacy-safe telemetry are persisted.

The model never constructs Microsoft Graph requests. It can only select registered tools whose arguments are validated before execution. Model-written confirmation language, including multiline Yes/No prompts, is rejected unless a real executable approval exists. A short clarification such as a date may retain an unresolved action goal, but it never carries approval: the exact write tool must still create a new approval record. External email content is treated as untrusted data, never as instruction.

After approval, a confirmed Microsoft 365 result is reported independently of approval-audit persistence. If Microsoft Graph returns an ambiguous transport failure, the assistant reports that the outcome is unconfirmed and asks the Director to check Outlook before retrying, preventing accidental duplicates.

## Executive intelligence

Inbox triage retains its original deterministic score and adds separately reported evidence signals for current requests, unanswered questions, decisions, exact stated deadlines, consequences, impact categories, suspicious content, and uninspected attachments. Quoted email history is excluded from current-request extraction. No relative or vague deadline becomes a precise date.

`mail_read` retrieves a bounded thread chronology and reports whether the latest verified message leaves the Director owing a reply or waiting on someone else. Dashboard and briefing inputs use the same typed assessment rather than asking the writing model to rediscover facts from prose.

Calendar reads report event overlaps. Calendar mutation previews verify conflicts without changing the requested time. The read-only availability tool intersects Microsoft Graph free/busy data for the Director and exact directory-resolved attendees inside Outlook working hours; it never creates a meeting or sends invitations.

## Durable memory

Before each non-fast-path model turn, a deterministic context assembler selects the immediate exchange and relevant older messages from the stored conversation. It is bounded to 16 messages and 12,000 characters, and includes at most six sanitised workflow summaries. Prepared actions are explicitly labelled unexecuted. Pending action authority still comes only from the approval store, never conversation prose.

Context telemetry records candidate count, selected count, estimated tokens, and fact count without logging message content.

Durable memory is opt-in and approval-gated. A clear standalone instruction such as `I prefer concise, structured reports` is parsed deterministically and immediately creates a review card; it does not depend on the model noticing the preference. Selecting **Yes, remember this** stores the memory in Supabase, after which relevant active memories are added to future prompts. Selecting **No** leaves memory unchanged.

Active memories are selected by scope and specificity. Global and operational rules remain eligible; person, project, email, calendar, and communication rules require matching context. Temporary entries expire out of retrieval but remain visible. Equal-scope opposing rules are withheld and shown as conflicts. The database-free fallback is user-scoped.

The assistant may observe repeated patterns as proposed memories, but proposals do not influence answers until the Director approves them. One-off email contents, calendar details, temporary plans and inferred opinions are not saved as durable facts. Duplicate active memories are ignored, and forgetting a memory also requires a preview and approval.

## Costs and attribution

Every model call is recorded in `ai_usage` with request, conversation, workflow, model role, response mode, actual service tier, purpose, iteration, token counts, cost and duration. Fast responses are charged to the internal ledger at twice the standard Sol token rates when OpenAI reports `priority` or `fast`. `OPENAI_MONTHLY_BUDGET_USD` remains the global hard stop. The recommended split reserves USD 4.50 for interactive work and USD 0.50 for briefings. Background model calls are disabled by a zero category budget until explicitly configured.

Unknown models use the highest configured rate until their current published rate is added to `apps/api/src/ai/cost.ts`. Apply migrations through `0013_openai_responses.sql` before deploying this version.

The proactive engine is deterministic and consumes no model budget. It can notify or recommend in the app, but it cannot call a mutating tool. Background reads are separately opt-in; see `docs/PROACTIVE.md`.

## Observability

The HTTP request ID and a separate workflow ID correlate assistant requests, model iterations, tool calls, approval lifecycle events, memory retrieval/proposals, security blocks and briefing generation. Telemetry is runtime-allowlisted. It never accepts message bodies, tool arguments, previews, tokens or arbitrary payload objects. See `docs/OBSERVABILITY.md`.

## Behavioural evaluation

Run `npm run eval:behaviour` to execute the 128-response Phase 2 humanisation corpus and its ten negative controls. This deterministic gate covers mechanically testable style, evidence and approval requirements without spending model budget. See `docs/BEHAVIOURAL_EVALS.md` for its limits and interpretation.

## Development

```bash
npm run test
npm run eval:behaviour
npm run typecheck
npm run test:agent
npm run verify:calendar-model
npm run test:graph
LOG_LEVEL=debug npm run dev:api
```

`DEMO_MODE=true` uses fixture mailbox data but still uses the configured OpenAI model for questions that do not have a deterministic fast path.

`npm run test:graph` is deliberately read-only. It validates the granted scopes and checks profile, mail, folders, calendar, contacts, relevant people, directory, mailbox settings and To Do without changing Microsoft 365 data.
