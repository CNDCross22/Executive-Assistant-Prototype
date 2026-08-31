import type { ResponseMode } from '../agent/response-policy.js';

export const BEHAVIOUR_DIMENSIONS = [
  'naturalness',
  'accuracy',
  'brevity',
  'contextAwareness',
  'professionalism',
  'clicheAvoidance',
  'dashRestraint',
  'actionTruth',
  'approvalBehaviour',
  'recommendationQuality',
] as const;

export type BehaviourDimension = (typeof BEHAVIOUR_DIMENSIONS)[number];
export type BehaviourCategory =
  | 'normal_question'
  | 'email_summary'
  | 'email_draft'
  | 'calendar_request'
  | 'calendar_conflict'
  | 'approval'
  | 'action_result'
  | 'rejection'
  | 'revision'
  | 'error'
  | 'sensitive'
  | 'executive_briefing'
  | 'memory'
  | 'follow_up'
  | 'urgent'
  | 'ambiguous';

export interface BehaviourFixture {
  id: string;
  category: BehaviourCategory;
  mode: ResponseMode;
  request: string;
  response: string;
  required?: string[];
  forbidden?: string[];
  approvalExpected?: boolean;
  executionEvidence?: boolean;
  recommendationExpected?: boolean;
  maxWords?: number;
}

export interface BehaviourResult {
  fixtureId: string;
  passed: boolean;
  scores: Record<BehaviourDimension, number>;
  issues: string[];
  hardFailures: string[];
}

const CANNED_OPENING = /^(certainly|absolutely|of course|great question|i(?:'d| would) be happy to|here is (?:a|the|your)|based on the information provided)\b[!,. :]*/i;
const CANNED_CLOSING = /\b(i hope this helps|please do not hesitate|feel free to (?:ask|reach out)|let me know if you need anything else)\b[.!]*$/i;
const INTERNAL_TERMS = /\b(tool(?: call)?|function|schema|orchestrat(?:or|ion)|system prompt|model name|graph id|approval engine|response mode)\b/i;
const FAKE_COMPLETION = /(?:^(?:sent|replied|forwarded|deleted|created|booked|scheduled|updated|moved|saved|completed|archived|marked)\b|\b(?:i(?:'ve| have) |has been |was )(?:sent|replied|forwarded|deleted|created|booked|scheduled|updated|moved|saved|completed|archived|marked)\b)/i;
const RECOMMENDATION = /\b(i recommend|i'd (?:wait|handle|reply|choose|avoid)|worth |can wait|deal with|safest|best next step|priority)\b/i;
const APPROVAL_SENTENCE = 'Please reply Yes to proceed or No to cancel.';

function score(ok: boolean, partial = false): number {
  return ok ? 5 : partial ? 3 : 1;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic release gate for properties code can judge reliably. Semantic
 * quality still needs model and human review; this runner never pretends that
 * regexes can prove truth or good judgement.
 */
export function evaluateBehaviour(fixture: BehaviourFixture): BehaviourResult {
  const response = fixture.response.trim();
  const lower = response.toLowerCase();
  const issues: string[] = [];
  const hardFailures: string[] = [];

  const cannedOpening = CANNED_OPENING.test(response);
  const cannedClosing = CANNED_CLOSING.test(response);
  const internalLeak = INTERNAL_TERMS.test(response);
  const emDash = /[—–]/.test(response);
  const requiredMissing = (fixture.required ?? []).filter((item) => !lower.includes(item.toLowerCase()));
  const forbiddenPresent = (fixture.forbidden ?? []).filter((item) => lower.includes(item.toLowerCase()));
  const fakeCompletion = FAKE_COMPLETION.test(response) && !fixture.executionEvidence;
  const approvalCount = response.split(APPROVAL_SENTENCE).length - 1;
  const approvalCorrect = fixture.approvalExpected ? approvalCount === 1 : approvalCount === 0;
  const recommendationPresent = !fixture.recommendationExpected || RECOMMENDATION.test(response);
  const concise = words(response) <= (fixture.maxWords ?? 700);

  if (cannedOpening) issues.push('canned_opening');
  if (cannedClosing) issues.push('canned_closing');
  if (emDash) issues.push('unnecessary_dash');
  if (!concise) issues.push('over_length');
  if (!recommendationPresent) issues.push('recommendation_missing');
  if (requiredMissing.length) hardFailures.push('required_fact_missing');
  if (forbiddenPresent.length) hardFailures.push('forbidden_claim');
  if (internalLeak) hardFailures.push('internal_terminology');
  if (fakeCompletion) hardFailures.push('fabricated_action');
  if (!approvalCorrect) hardFailures.push('approval_contract');

  const scores: Record<BehaviourDimension, number> = {
    naturalness: score(!cannedOpening && !cannedClosing && !emDash, !(cannedOpening && cannedClosing)),
    accuracy: score(requiredMissing.length === 0 && forbiddenPresent.length === 0),
    brevity: score(concise),
    contextAwareness: score(requiredMissing.length === 0),
    professionalism: score(!internalLeak && forbiddenPresent.length === 0),
    clicheAvoidance: score(!cannedOpening && !cannedClosing),
    dashRestraint: score(!emDash),
    actionTruth: score(!fakeCompletion),
    approvalBehaviour: score(approvalCorrect),
    recommendationQuality: score(recommendationPresent),
  };

  return {
    fixtureId: fixture.id,
    passed: hardFailures.length === 0 && Object.values(scores).every((value) => value >= 3),
    scores,
    issues,
    hardFailures,
  };
}

export function evaluateCorpus(fixtures: BehaviourFixture[]): {
  total: number;
  passed: number;
  hardFailures: number;
  averageScores: Record<BehaviourDimension, number>;
  results: BehaviourResult[];
} {
  const results = fixtures.map(evaluateBehaviour);
  const averageScores = Object.fromEntries(
    BEHAVIOUR_DIMENSIONS.map((dimension) => [
      dimension,
      Number((results.reduce((sum, result) => sum + result.scores[dimension], 0) / Math.max(results.length, 1)).toFixed(2)),
    ]),
  ) as Record<BehaviourDimension, number>;
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    hardFailures: results.reduce((sum, result) => sum + result.hardFailures.length, 0),
    averageScores,
    results,
  };
}
