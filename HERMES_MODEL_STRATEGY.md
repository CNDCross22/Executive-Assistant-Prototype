# Hermes Model Strategy

Version: 2.0 planning specification
Prepared: 31 August 2026

## Status legend

**CONFIRMED** is source- or documentation-backed. **INFERRED** is not live-tested. **PROPOSED** is the target policy. **REQUIRES VERIFICATION** must be checked against the production account and current pricing before release.

## 1. Current behaviour

**CONFIRMED**:

- Hermes uses the official OpenAI Node SDK version 7.5.0.
- The implementation calls Chat Completions through one `OpenAIProvider` instance.
- The SDK exposes both `chat.completions.create()` and `responses.create()`.
- `OPENAI_MODEL` is currently `gpt-5-mini` and is used for ordinary chat and briefing.
- GPT-5-family requests receive `reasoning_effort: "minimal"`, `max_completion_tokens`, and no temperature override.
- Ordinary chat has an 800-token completion ceiling; briefing has 500.
- Usage is recorded per model and purpose with prompt, cached, completion tokens, duration, and cost.
- A USD 5 monthly hard cap prevents further model calls; deterministic features continue.

**INFERRED**: The current account can probably access the configured model because it is the current local setting, but this was not live-verified.

## 2. Current official model/API findings

**CONFIRMED as of 31 August 2026** from official OpenAI documentation:

- OpenAI recommends the GPT-5.6 family for current general workloads and recommends the Responses API for reasoning, tool calling, and multi-turn agentic work: [Latest model guide](https://developers.openai.com/api/docs/guides/latest-model).
- The current catalog positions GPT-5.6 Sol as flagship, Terra as balanced, and Luna as lower-cost/high-throughput: [Model catalog](https://developers.openai.com/api/docs/models).
- GPT-5.6 Sol supports both Chat Completions and Responses, function calling, and structured outputs. Hosted tools are Responses-only: [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
- The official catalog currently shows per-million-token prices of Sol USD 4 input, USD 0.40 cached input, USD 20 output; Terra USD 2, USD 0.20, USD 12; Luna USD 0.20, USD 0.02, USD 1.20.

**REQUIRES VERIFICATION**: Prices are time-sensitive and Sol pricing is described as promotional through at least 21 November 2026. Account access, regional availability, snapshots, rate limits, data-retention settings, and exact billing treatment must be checked immediately before implementation. These values must not be treated as permanent source constants.

## 3. Proposed behaviour

**PROPOSED**: Introduce model roles, not model sprawl:

| Role | Work | Initial evaluation candidates | Default release posture |
|---|---|---|---|
| FAST | classification, lightweight extraction, compact routine summaries | current `gpt-5-mini`; GPT-5.6 Luna | Remain on current model until parity/cost evaluation |
| EXECUTIVE | ambiguous multi-factor work, sensitive drafts, calendar reasoning, decision support | GPT-5.6 Terra; GPT-5.6 Sol as quality benchmark | Select only after behavioural and tool-safety gates |
| BRIEFING | evidence-based morning note | GPT-5.6 Terra or Luna depending measured quality | Separate role and budget, deterministic fallback |
| BACKGROUND | future event classification/pattern detection | GPT-5.6 Luna or no model | Disabled until proactive phase |

This table is an evaluation plan, not a production model decision.

**PROPOSED** configuration:

```dotenv
OPENAI_FAST_MODEL=
OPENAI_EXECUTIVE_MODEL=
OPENAI_BRIEFING_MODEL=
OPENAI_BACKGROUND_MODEL=
OPENAI_DEFAULT_REASONING_EFFORT=low
OPENAI_EXECUTIVE_REASONING_EFFORT=medium
OPENAI_MONTHLY_BUDGET_USD=5
OPENAI_INTERACTIVE_BUDGET_USD=
OPENAI_BRIEFING_BUDGET_USD=
OPENAI_BACKGROUND_BUDGET_USD=0
```

Legacy `OPENAI_MODEL` remains the fallback during migration. Empty role values inherit it.

## 4. Reason for change

**PROPOSED rationale**:

- Counting unread mail should not pay the latency/cost of the best reasoning model.
- A sensitive board-level draft should not be limited by settings chosen for routine classification.
- Briefings require a predictable format and budget separate from interactive work.
- Background work must never silently consume the interactive allowance.
- A model upgrade must be evaluated as a system change involving context, tools, and validation, not assumed to solve all quality problems.

## 5. Implementation approach

### 5.1 Policy contract

**PROPOSED**: Define `ModelRole`, `ModelPolicyInput`, and `ResolvedModelPolicy`. Inputs include response mode, request complexity, sensitivity, tool category, iteration number, remaining budgets, and feature flags. Output includes provider, model, API path, reasoning effort, completion limit, purpose, and fallback chain.

Policy is deterministic and testable. The model never chooses its own role or reasoning budget.

### 5.2 API path

**PROPOSED**: Do not combine model upgrade and API migration in one release. First make the provider model-configurable while retaining Chat Completions. Then implement a Responses adapter behind the same provider contract and run parity tests for:

- function/tool definitions and parallel calls;
- tool result continuation;
- reasoning effort fields;
- cancellation and timeout;
- token/cached-token usage reporting;
- refusal and empty-output handling;
- exact action-claim evidence;
- multi-iteration context behaviour.

Use Responses only when it demonstrates equal or better approval/tool safety and accurate accounting. The installed SDK is compatible, but current Hermes code is not yet implemented against it.

### 5.3 Adaptive completion policy

**PROPOSED**: Replace call-site constants with tested response-mode ranges. Initial ceilings for evaluation, not production promises:

- Direct: 250 to 450 tokens.
- Action preview/result/error: 300 to 600 tokens, usually much shorter.
- Draft: 800 to 1,500 tokens or bounded by the requested communication.
- Executive: 1,200 to 2,500 tokens.
- Briefing: 800 to 1,200 tokens.

The policy should request less by default and raise the ceiling only when the mode justifies it. A maximum is not a target length.

### 5.4 Cost attribution

**PROPOSED**: Record user request, conversation, workflow, model role, response mode, iteration, and briefing/proactive event. Calculate prices from a versioned model-rate catalog with effective dates. Unknown models remain pessimistically priced and may be denied in production until configured.

### 5.5 Quality evaluation

**PROPOSED**: Run fixed scenarios through candidate policies. Score correctness, tool choice, argument accuracy, unsupported claims, approval compliance, naturalness, latency, input/output tokens, and calculated cost. A model wins only if the end-to-end workflow improves.

## 6. Affected files

**PROPOSED**:

- `apps/api/src/config/env.ts`, `.env.example`, setup/status responses.
- `apps/api/src/ai/provider.ts`, `openai.ts`, `index.ts`, `cost.ts`.
- New `apps/api/src/ai/policy.ts` and optionally `responses.ts`.
- `agent/orchestrator.ts`, `dashboard/briefing.ts`, future proactive runner.
- Shared types, setup UI, docs, and tests/evaluation fixtures.

## 7. Database changes

**PROPOSED**: Add nullable request/conversation/workflow/model-role/response-mode columns to `ai_usage`, plus an effective pricing version or rate identifier. Consider category-budget state as configuration rather than mutable database data initially. If administrator-editable budgets are later required, store them in tenant/user settings with validation and audit.

No conversation content is added to usage rows.

## 8. API changes

**PROPOSED**:

- `GET /api/setup` and authenticated status report configured role names, effective fallback, and category budget status without exposing API keys.
- Assistant responses may include a non-user-facing policy/version identifier for diagnostics, but the UI should not display internal model names in normal conversation.
- Preserve existing chat request shape.

## 9. Security implications

**PROPOSED**:

- Every model/API path receives the same restricted tool set, untrusted-content framing, opaque references, approval boundary, and claim guard.
- Fallback cannot weaken reasoning/action rules or switch to an unapproved external provider.
- Do not send more conversation or mailbox data merely because a model supports a larger context window.
- Redact model request bodies from ordinary logs.
- Validate that Responses persisted-state options meet Hermes privacy requirements before use. Prefer application-owned context unless retention policy is explicitly accepted.

## 10. Cost implications

At current published prices, Terra output is ten times Luna output, and Sol is more expensive again. A USD 5 monthly cap makes unrestricted flagship use impractical for frequent production interaction.

**PROPOSED**:

- Keep deterministic fast paths at zero model cost.
- Use the executive role only when complexity warrants it.
- Reserve an interactive budget floor that background work cannot consume.
- Warn at per-category thresholds and stop at hard caps.
- Report projected spend by role.
- Store cached input tokens distinctly and validate provider usage fields during Responses migration.

**REQUIRES VERIFICATION**: Real prompt size, completion size, cache eligibility, monthly volume, and target latency. Cost recommendations must be recalculated from official prices at rollout.

## 11. Failure cases

- Configured model unavailable or not entitled: fail over only to configured compatible fallback and report degraded capability.
- SDK accepts a field that the selected model rejects: compatibility matrix and contract test block deployment.
- Higher reasoning consumes the output budget before a useful answer: measure and set role-specific limits.
- Responses usage differs from Chat Completions: do not release until cost accounting reconciles.
- Model policy loops between fallbacks: one ordered attempt chain with bounded retries.
- Budget database unavailable: choose a conservative configurable failure mode; production should deny discretionary/background calls rather than assume free capacity.
- Quality improves but action argument accuracy drops: reject the candidate regardless of prose quality.

## 12. Tests

**PROPOSED**:

- Unit tests for environment fallback, role resolution, reasoning/limit payloads, pricing effective dates, category caps, and unknown models.
- Provider contract tests for Chat Completions and Responses with recorded/fake responses.
- Integration tests for multi-tool loops, cancellation, retry, timeout, refusal, malformed tool arguments, and usage recording.
- Behavioural A/B evaluations using the same 100+ fixtures.
- Budget exhaustion at global and category levels.
- Regression tests proving no mutating tool bypasses approval under any role/API path.

## 13. Acceptance criteria

- Model choice is configurable per purpose with legacy fallback.
- The selected API payload is documented and validated for every enabled model.
- Usage and cost reconcile with provider token fields.
- Global and category budgets stop calls deterministically.
- Background budget defaults to zero until enabled.
- Executive scenarios improve against the fixed baseline without worse action safety.
- No model/API migration is enabled solely because it is newer.

## 14. Migration and rollback strategy

**PROPOSED**:

1. Add role configuration inheriting `OPENAI_MODEL`; behaviour remains identical.
2. Pass model explicitly per call and expand usage attribution.
3. Evaluate Luna, Terra, and Sol against current `gpt-5-mini` where account access permits.
4. Canary the winning executive/briefing policy while FAST remains unchanged.
5. Implement Responses as a second adapter; shadow and then canary it separately.
6. Promote only after cost, latency, tool, and behavioural gates pass.

Rollback sets all roles to `OPENAI_MODEL`, disables the Responses adapter, and retains additive usage records. No approval or Graph code changes are required to roll back a model policy.
