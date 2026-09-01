# Hermes Model Strategy

Version: 2.1 implementation specification
Prepared: 31 August 2026

## Status legend

**CONFIRMED** is verified in code, tests, or current official documentation. **INFERRED** is a reasoned conclusion that has not been production-measured. **PROPOSED** is future work. **REQUIRES VERIFICATION** must be checked against live account behaviour.

## 1. Current behaviour

**CONFIRMED**:

- Hermes uses the official OpenAI Node SDK and the Responses API.
- Routine direct and action-status work uses `gpt-5.6-luna` with reasoning `none` and Fast processing.
- Executive analysis, drafts, and sensitive work use `gpt-5.6-sol` with reasoning `medium` and Fast processing.
- Briefings use `gpt-5.6-sol` with reasoning `medium` and Fast processing.
- The reserved background role uses Luna with reasoning `none`, but its category budget is zero and background model work is disabled.
- Response modes apply adaptive output ceilings without requiring long answers.
- The global model budget is USD 10 per month. The category split is USD 8 interactive and USD 2 briefing.
- Every model iteration is independently budget-checked and attributed by request, conversation, workflow, role, mode, model, actual service tier, token usage, duration, and cost.
- Microsoft 365 tools, opaque references, approval previews, strict approval matching, action-claim checks, and output sanitisation are unchanged.

## 2. Official model and API findings

**CONFIRMED as of 31 August 2026**:

- OpenAI recommends its current GPT-5.6 family and recommends Responses for reasoning, function tools, and multi-turn model workflows.
- GPT-5.6 Sol is the flagship reasoning model. Its published standard rates are USD 4 per million input tokens, USD 0.40 cached input, and USD 20 output.
- GPT-5.6 Luna is the high-throughput, cost-sensitive model. Its published rates are USD 0.20 per million input tokens, USD 0.02 cached input, and USD 1.20 output.
- Fast processing for Sol is requested with `service_tier=fast`; OpenAI reports the effective tier in the response and currently bills Fast at twice standard token rates.
- Sol tool workflows with reasoning require the Responses API compatibility path used here. A Chat Completions model-name-only switch would not provide the intended configuration safely.

**REQUIRES VERIFICATION**: Pricing, account access, rate limits, regional availability, promotion dates, and the service tier returned by the production project remain external and time-sensitive.

## 3. Why this policy

**CONFIRMED**: The USD 10 cap keeps flagship use bounded. Luna remains suitable for frequent routine work, while Sol is used where ambiguity, consequences, drafting quality, briefing quality, or multi-factor reasoning justify its higher price.

**INFERRED**: This mix should provide better perceived speed and reasoning per dollar than using one model for every task. Production latency and quality telemetry are needed to quantify the benefit.

## 4. Implementation approach

The deterministic response classifier selects one of four model roles. The model cannot select its own role, service tier, budget, or tool access. The provider sends bounded Hermes-owned context to Responses with `store: false`.

For a function-tool loop, Hermes requests encrypted reasoning output and replays the returned provider items only in memory with the corresponding function result. These items are not stored in the conversation database, shown to the Director, or written to logs. Parallel function calls are disabled so one ordered workflow remains easy to validate and audit.

All function arguments are still validated in Hermes immediately before execution. A mutating tool still creates an exact, expiring approval record and stops the model loop. No model or API setting can execute the action directly.

## 5. Affected files

- `apps/api/src/ai/openai.ts`: Responses request/response mapping and stateless reasoning continuation.
- `apps/api/src/ai/provider.ts`: ephemeral provider state and actual service-tier result.
- `apps/api/src/ai/policy.ts`: purpose model, reasoning, tier, and budget policy.
- `apps/api/src/ai/cost.ts`: current model rates and Fast-tier multiplier.
- `apps/api/src/config/env.ts`: safe production defaults and validation.
- `apps/api/src/agent/orchestrator.ts`: provider-state continuation and tier attribution.
- `apps/api/src/dashboard/briefing.ts`: briefing tier attribution.
- `apps/api/src/observability/telemetry.ts`: allowlisted service-tier telemetry.
- `supabase/functions/api/index.ts`: Edge secret forwarding.
- `.env.example`, `docs/AI_AGENT.md`: deployment contract.

## 6. Database changes

Migration `0013_openai_responses.sql` adds nullable `ai_usage.service_tier` and a time-ordered partial index. It is additive. Existing rows remain valid and older application versions ignore the new column.

No prompts, reasoning content, email bodies, or tool arguments are added to usage records.

## 7. API changes

The browser chat request and response shapes are unchanged. Setup and authenticated AI status now include the effective service tier for each internal model role. These diagnostics do not expose the OpenAI key.

The model provider has changed from Chat Completions to Responses. This is an internal server boundary and does not grant any hosted OpenAI tools.

## 8. Security implications

- `store: false` prevents Hermes from relying on OpenAI-hosted conversation state.
- Reasoning continuation is opaque, ephemeral, and never exposed.
- Tool results remain untrusted data inside the system prompt boundary.
- The relevant-tool selector remains in control; the model receives no arbitrary HTTP tool.
- Parallel function calls are disabled to preserve ordered validation and the single-pending-approval rule.
- Existing approval, tenant, allowlist, claim, sanitisation, and Microsoft Graph boundaries remain unchanged.

## 9. Cost implications

Luna standard costs USD 1.40 for one million uncached input plus one million output tokens at the currently published rates. Sol standard costs USD 24 for the same token mix. Sol Fast is accounted at USD 48 for that mix.

The dollar figures are illustrative, not a usage forecast. Hermes charges cached and fresh input separately, uses the actual returned service tier, and refuses new model calls once either the relevant category cap or the global USD 5 cap is reached. Unknown models remain pessimistically priced.

## 10. Failure cases

- Model unavailable: return a safe service-unavailable error; do not silently switch to an unapproved model.
- Fast downgraded or returned as another tier: record the tier OpenAI reports and cost by the known effective tier.
- Empty or incomplete response: log metadata without content and return Hermes' safe fallback.
- Invalid function arguments: existing schema validation rejects the call.
- Timeout before mutation: nothing changes.
- Uncertain Microsoft mutation result: do not retry blindly or claim success.
- Usage recording failure: report it to server logs; the action result is not falsified.
- Missing database migration: usage insertion fails safely, but release validation must block deployment until migration 0013 is present.

## 11. Tests

- Model role, reasoning, and service-tier selection.
- Responses payload fields and GPT-5 reasoning configuration.
- Function definition conversion.
- Stateless encrypted reasoning replay through a function call and output.
- Responses usage and actual service-tier parsing.
- Luna, Sol, cached-token, Fast-tier, snapshot, and unknown-model pricing.
- Global and category budget guards.
- Existing unit, integration, behavioural, approval, action-claim, and Microsoft Graph safety suites.

## 12. Acceptance criteria

- Routine and executive requests resolve to the documented model policies.
- Sol can reason across a Hermes function-tool loop through Responses.
- No provider reasoning state is persisted or logged.
- Actual service tier affects cost accounting.
- The global USD 5 hard cap and zero background cap remain active.
- Every mutating Microsoft 365 operation still requires an exact stored approval.
- Type checks, automated tests, behavioural evaluation, Edge build, model availability smoke tests, and live deployment checks pass.

## 13. Migration and rollback

1. Apply migration 0013.
2. Deploy the Responses-compatible Edge bundle.
3. Set role models, reasoning, service tiers, and category budgets.
4. Verify setup/status and run read-only live smoke checks.

Rollback is configuration-first: set executive, fast, and briefing roles to a known Responses-compatible fallback with reasoning `none` and service tier `default`. If code rollback is required, the additive database column is retained. Rolling back the database is unnecessary and would remove useful cost audit data.

## 14. Further work

**PROPOSED**: Measure real latency, cost per request type, executive-task quality, and Fast-tier value over a representative period. True token streaming is not part of this migration because the deployed Supabase Edge adapter currently buffers Fastify injection responses. It should be added only with a transport design that never streams an unvalidated action claim or a model-written approval preview.
