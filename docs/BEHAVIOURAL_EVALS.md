# Behavioural evaluations

Phase 2 introduces a deterministic humanisation release gate:

```powershell
npm.cmd run eval:behaviour
```

The command compiles the API evaluation runner and checks 128 synthetic Director-facing responses across 16 categories. It uses no production mailbox content and makes no model calls.

## Dimensions

Every response is scored from 1 to 5 for:

1. Naturalness
2. Accuracy against declared required and forbidden facts
3. Brevity
4. Context awareness
5. Professionalism
6. AI-cliché avoidance
7. Dash restraint
8. Action truth
9. Approval behaviour
10. Recommendation quality

Fabricated actions, missing required facts, forbidden claims, internal terminology and a broken approval contract are hard failures. Ten negative controls must all be rejected, which verifies that the evaluator is capable of failing.

## What this proves

The deterministic suite proves that reference responses and production writing policies satisfy mechanically testable product rules. It does not prove that arbitrary model output is factually correct or has good executive judgement. Model-backed evaluations and human review remain required before changing the production model or enabling adaptive response limits by default.

The corpus and evaluator are versioned in:

- `apps/api/src/evals/fixtures.ts`
- `apps/api/src/evals/behavioural.ts`
- `apps/api/src/evals/run.ts`

The Node test suite also executes the release gate and tests the negative controls.
