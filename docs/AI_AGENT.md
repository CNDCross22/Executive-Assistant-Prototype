# The Hermes agent

How a question becomes an answer, and where to change things.

---

## Switching AI provider

This is the whole procedure. No code changes.

```dotenv
# OpenAI (current)
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-5-mini
AI_API_KEY=sk-...

# Azure OpenAI — keeps data inside your Microsoft tenant
AI_BASE_URL=https://<resource>.openai.azure.com/openai/v1
AI_MODEL=<your deployment name>

# Local, via Ollama
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=hermes3:8b
AI_API_KEY=ollama

# OpenRouter — Hermes 4, Llama, anything
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=nousresearch/hermes-4-70b
```

Restart the API and check `GET /api/setup` — the `ai` block reports what is loaded, and
`GET /api/assistant/status` performs a live reachability check against the model.

**Anthropic is not implemented.** `AI_PROVIDER=anthropic` throws a clear error rather than
failing mysteriously. Their API is not OpenAI-shaped, so it needs a real adapter in
`src/ai/anthropicProvider.ts` implementing the same `AIProvider` interface. Roughly half a
day including tool-call translation and prompt caching.

### After switching models, check these

A different model will behave differently. In rough order of likelihood:

| Symptom | Where to look |
|---|---|
| Answers too long or using markdown | `soul.md`, and the closing instruction in `formatToolResult` |
| Wrong tool chosen | Tool `description` fields in `agent/tools/*.tools.ts` |
| Not calling tools at all | `temperature` and `tool_choice` in `orchestrator.ts` |
| Leaking internals | `agent/sanitise.ts` — add the pattern |
| Claiming actions it did not take | `agent/guards.ts` — already blocks this, but widen `ACTION_CLAIMS` |
| Costs above forecast | `ai/cost.ts` — add the model's published rate to `RATES` |

**Add the new model to `RATES` in `ai/cost.ts` before going live.** An unpriced model is
billed at the highest known rate as a safety measure, which will make your spend meter wrong.

---

## The path of a question

```
message
  │
  ├─ 1. checkCapability()      guards.ts     asked for something we cannot do? refuse now
  │
  ├─ 2. observeFromMessage()   learning.ts   did she state a preference? note it (regex only)
  │
  ├─ 3. tryFastPath()          fastpath.ts   a known question? answer from data, 0ms, no model
  │
  ├─ 4. recall()               memory/       what do we know that is relevant?
  │
  ├─ 5. systemPrompt()         prompt.ts     soul + memory + selected skills + trust rules
  │
  ├─ 6. loop, max 6 iterations orchestrator
  │      ├─ assertWithinBudget()             refuse if the month's cap is spent
  │      ├─ provider.chat()                  the only place a vendor is named
  │      ├─ executeTool()      registry.ts   validate args against zod, then run
  │      └─ formatToolResult() prompt.ts     wrap results as untrusted DATA
  │
  ├─ 7. checkClaims()          guards.ts     block "I sent it" when nothing was sent
  ├─ 8. sanitiseReply()        sanitise.ts   strip ids, tool names, markdown, padding
  └─ 9. appendMessage()        conversations persist the turn
```

Steps 1, 3, 7 and 8 are **enforcement, not instruction**. They exist because asking a model
nicely is not a control. Every one of them was added after a real failure — see the comments
in those files for what went wrong.

---

## Adding a tool

One file, one object. `agent/tools/mail.tools.ts` is the fullest example.

```ts
export const myTool = defineTool({
  name: 'calendar_find_slots',
  description: 'Plain English. The model reads this to decide when to call it.',
  riskLevel: 0,              // 0 read · 1 private write · 2 external · 3 destructive
  capability: 'calendar_read', // must be enabled in config/graphScopes.ts
  schema: z.object({ ... }),   // arguments are rejected unless they validate
  parameters: objectSchema({ ... }), // JSON Schema shown to the model
  summarise: (a) => 'Looked for free time',  // shown to her; never include content
  async execute(args, ctx) { ... },
});
```

Then add it to the array at the bottom of the file, and to a skill's `tools` list in
`agent/skills.ts` so it is actually offered for relevant questions.

**Risk levels above 0 are refused** until the approval engine exists — see `registry.ts`.
That is deliberate: a tool that can change things must not be reachable before there is a
confirmation step in front of it.

**Keep results small.** Tool output is re-read by the model on every subsequent iteration.
Return digested facts, not raw records.

---

## Costs

Every call is priced and recorded in `ai_usage`. Watch it at `GET /api/setup` → `spend`.

- `AI_MONTHLY_BUDGET_USD` is a **hard stop**, not a warning. Past it, model calls are refused.
- Hitting the cap **degrades rather than breaks**: the fast paths keep working at full speed.
- Set it to `0` to disable the cap entirely.

The stable prompt prefix (soul + skills + tools) is cached by the provider automatically,
billing at roughly a tenth of normal. Keep `soul.md` under ~400 words: every word is re-read
on every iteration of every turn.

---

## Why so much is deterministic

Roughly 80% of the value here never touches a model:

| Job | Where | Why not the model |
|---|---|---|
| Ranking what matters | `mail/triage.ts` | Queries cannot be confidently wrong |
| Follow-up detection | `mail/triage.ts` | Comparing sent against received is arithmetic |
| Phishing detection | `mail/suspicion.ts` | A small model summarised attacks neutrally |
| Common answers | `agent/fastpath.ts` | 0ms instead of 75s, and always accurate |
| Preference detection | `memory/learning.ts` | Regex cannot invent a preference she never stated |

The model's job is judgement and phrasing on the questions that genuinely need it. Everything
a rule can do, a rule does.

---

## Debugging

```bash
npm run test:agent     # full chain against fixture mail — no Microsoft needed
LOG_LEVEL=debug npm run dev:api
```

`DEMO_MODE=true` in `.env` serves a fixture mailbox with a planted phishing email, so the
whole loop can be exercised without a Microsoft connection. It is refused in production and
shows a banner in the UI.

Useful log lines: `Answered without the model`, `Blocked an unbacked action claim`,
`Preference proposed`, `Tool executed`, `Refused: capability not enabled`.
