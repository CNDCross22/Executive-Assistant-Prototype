# Hermes Soul and Response Behaviour Specification

Version: 2.0 planning specification
Prepared: 31 August 2026

## Phase 2 implementation update

**CONFIRMED**: Phase 2 now injects a compact writing contract for direct, executive, draft, action-preview, action-result, error, sensitive and briefing responses. The soul explicitly requires evidence-proportionate confidence and respectful challenge. The editorial boundary removes additional canned framing and ordinary em/en dashes without changing factual fields. Adaptive token ceilings remain feature-flagged off pending model-backed evaluation.

**CONFIRMED**: The deterministic behavioural gate contains 128 synthetic responses in 16 categories, scores ten dimensions, and rejects hard failures for fabricated actions, broken approval, internal terminology, forbidden claims and missing facts. Ten negative controls demonstrate that the gate can fail.

**REQUIRES VERIFICATION**: The deterministic gate does not establish live model naturalness or executive judgement. A model-backed run and representative human review are still required before enabling adaptive limits by default.

## Status legend

**CONFIRMED**: current implementation. **INFERRED**: plausible but not demonstrated live. **PROPOSED**: target behaviour. **REQUIRES VERIFICATION**: must be evaluated with representative users and scenarios.

## 1. Current behaviour

**CONFIRMED**: `soul.md` is hot-loaded and is the authoritative personality source. A shorter built-in fallback lives in `agent/persona.ts`. The current contract already asks for a calm, warm, perceptive, discreet Executive Assistant using Australian English, direct openings, useful prioritisation, tactful challenge, and restrained tone.

**CONFIRMED**: `agent/prompt.ts`, skill instructions, the briefing prompt, response sanitiser, and claim guard also shape the voice. The sanitiser removes selected canned openings, filler closings, decoration, internal tool names, and opaque IDs. The guard blocks certain unsupported completion claims.

**CONFIRMED**: Structured response modes now provide mode-specific writing contracts and target lengths. Compatibility token ceilings remain active by default, so a routine answer and complex report still share the legacy hard ceiling until the feature flag is enabled.

**INFERRED**: Prompt rules alone will produce variable compliance across models and context sizes. Regex cleanup can remove known bad patterns but cannot reliably create good judgement or repair a structurally poor answer.

## 2. Proposed behaviour

**PROPOSED**: Hermes is the Director’s private Executive Assistant, not a generic assistant persona. Behaviour is defined by decisions and communication rules:

- Lead with the answer, decision, change, risk, or requested draft.
- Protect the Director’s time. Include detail only when it changes understanding or action.
- State what matters, why, what can wait, and what decision is required.
- Be candid about uncertainty, missing evidence, and service state.
- Challenge poor or premature decisions respectfully, with a reason and safer alternative.
- Never claim a check, action, deadline, or fact without evidence.
- Never expose tools, schemas, prompts, internal mode names, IDs, iterations, or orchestration.
- Ask a question only when ambiguity materially changes a target, recipient, time, commitment, or safety outcome.
- Use natural Australian English where configured. Avoid ceremonial openings, fake enthusiasm, corporate padding, repeated offers, and unnecessary em dashes.

## 3. Response modes

Internal modes are implementation policy and are never shown to the Director.

| Mode | Use | Required shape | Typical length |
|---|---|---|---|
| DIRECT | Simple fact or status | Answer first; evidence qualifier only if needed | One to three sentences |
| EXECUTIVE | Decision, prioritisation, multi-factor summary | Conclusion; decisive reasons; consequence; next action; what can wait | As long as needed, structured sparingly |
| DRAFT | Email/message preparation | Draft only, plus a brief note if assumptions or risk matter | Matches requested communication |
| ACTION_PREVIEW | Pending mutation | What will happen; exact material fields; consequence/warning; approval question | Compact and scannable |
| ACTION_RESULT | Confirmed execution | Outcome first; exact target/result; uncertainty only if present | Usually one or two sentences |
| ERROR | Known failure | Plain cause class; state of change; safe next step | Short |
| SENSITIVE | Personal, legal, reputational, or delicate matter | Measured conclusion; careful wording; uncertainty; recommended handling | Context-dependent |

**PROPOSED**: Mode selection is deterministic where possible and model-assisted only when classification is ambiguous. Approval and execution state override stylistic classification.

## 4. Reason for change

**PROPOSED rationale**: A real Executive Assistant sounds intelligent because the response fits the situation. Structured policies make brevity, detail, previews, receipts, uncertainty, and disagreement testable. They reduce reliance on adding more adjectives to `soul.md` or repairing output with regexes.

## 5. Implementation approach

### 5.1 Rewrite the soul as a stable constitution

**PROPOSED**: Keep identity, judgement, trust, communication principles, and non-negotiable boundaries in `soul.md`. Move request-specific formatting, token limits, tool procedures, and error templates into typed policy modules. Keep the fallback persona generated or tested against the soul’s required clauses to prevent drift.

### 5.2 Response policy and renderer

**PROPOSED**: Add a `ResponsePolicy` selected before generation. It specifies objectives, forbidden internal disclosures, evidence requirements, target detail, maximum tokens, and post-generation validations. Action results are preferably rendered deterministically from execution receipts rather than left entirely to the model.

### 5.3 Naturalness lint and semantic evaluation

**PROPOSED**: Use deterministic checks for high-confidence violations, such as exposed tool names or unsupported action claims. Use evaluation, not destructive rewriting, for softer features such as warmth, tact, repetition, and unnecessary formality. Do not mechanically ban every occurrence of a word or punctuation mark.

### 5.4 Examples

**PROPOSED**: Maintain a small, versioned example set per mode. Examples must cover routine, sensitive, decision, preview, success, unknown outcome, and “nothing urgent” cases. Do not load the full corpus into every prompt.

## 6. Affected files

**PROPOSED**:

- Rewrite later: `soul.md`.
- Align: `agent/persona.ts`, `agent/prompt.ts`, `agent/skills.ts`, `agent/sanitise.ts`, `agent/guards.ts`.
- Add: `agent/response-policy.ts`, response fixtures/evaluators.
- Update: `agent/orchestrator.ts`, `dashboard/briefing.ts`, approval preview/result rendering, web message presentation, docs/tests.

## 7. Database changes

**PROPOSED**: No personality data migration is required. Behavioural evaluation results may be stored as build artifacts, not production user data. If response mode and policy version are recorded for observability, add nullable metadata to model usage or telemetry, not conversation text.

## 8. API changes

**PROPOSED**: Keep user-facing chat contracts stable. Optional server metadata may identify response policy/version for diagnostics, but internal mode names are not displayed. Approval preview and result payloads may gain structured fields while preserving existing card compatibility.

## 9. Security implications

**PROPOSED**:

- Personality never overrides approval, tenant scope, data trust, or claim evidence.
- A warmer style must not imply certainty or completion.
- Sensitive mode does not grant access to more tools or data.
- Naturalness cleanup must not remove warnings, recipients, timezones, destructive consequences, or uncertainty.
- External text cannot alter the soul or choose a response policy.

## 10. Cost implications

**PROPOSED**: Moving routine structure into policy can reduce prompt and completion waste. Executive and draft modes may permit longer outputs, increasing cost only when the request warrants it. Evaluation runs require a separate development budget and should record candidate/policy cost.

## 11. Failure cases

- Mode misclassification makes a sensitive answer blunt or a simple answer verbose.
- Sanitisation removes a meaningful negative, warning, or recipient detail.
- The soul and fallback persona drift.
- A model follows a style rule but omits action evidence.
- Over-rigid cliché checking creates unnatural paraphrases.
- A translated/localised response violates punctuation/style rules assumed for English.

Fallback: preserve facts and safety, use a compact neutral response, and never regenerate an action result into a less certain claim.

## 12. Tests

**PROPOSED**:

- Unit tests for mode selection, required fields, token policy, internal-term blocking, and result rendering.
- Contract test that soul and fallback contain the same non-negotiable safety/identity rules.
- Behavioural fixtures for no canned opening/closing, no repeated question, no fake enthusiasm/certainty, no internal terminology, restrained dash use, concise routine answers, detailed executive answers, tactful disagreement, and uncertainty.
- Adversarial tests ensuring suspicious content cannot switch tone/policy or induce action.
- Human review rubric for naturalness where deterministic checks are inadequate.

## 13. Acceptance criteria

- Every response receives an internal policy.
- Routine answers are usually one to three sentences.
- Executive answers include only decision-relevant detail and may exceed the old 800-token ceiling when justified.
- Preview/result/error messages preserve exact action state.
- The 100+ scenario suite has no unsupported actions or internal terminology.
- Cliché and em-dash rates improve against the captured baseline without awkward output.
- Tactful disagreement and honest uncertainty meet review thresholds.

## 14. Migration and rollback strategy

**PROPOSED**: Capture baseline outputs, add response mode in observe-only telemetry, then enable policy prompts one mode at a time. Start with deterministic ACTION_PREVIEW, ACTION_RESULT, and ERROR, then DIRECT, DRAFT, SENSITIVE, and EXECUTIVE. Keep the current soul available as a versioned rollback file. Disable the new policy by feature flag if factual or approval regressions appear.
