import { env } from '../config/env.js';

export type ResponseMode =
  | 'direct'
  | 'executive'
  | 'draft'
  | 'action_preview'
  | 'action_result'
  | 'error'
  | 'sensitive'
  | 'briefing';

export interface ResponsePolicy {
  mode: ResponseMode;
  maxTokens: number;
  adaptiveLimitsEnabled: boolean;
  expectsRecommendation: boolean;
  requiresActionEvidence: boolean;
  targetWords: readonly [number, number];
}

const ADAPTIVE_LIMITS: Record<ResponseMode, number> = {
  direct: 400,
  executive: 1_800,
  draft: 1_500,
  action_preview: 500,
  action_result: 400,
  error: 400,
  sensitive: 1_400,
  briefing: 1_000,
};

const TARGET_WORDS: Record<ResponseMode, readonly [number, number]> = {
  direct: [1, 90],
  executive: [80, 700],
  draft: [20, 500],
  action_preview: [20, 220],
  action_result: [1, 90],
  error: [8, 120],
  sensitive: [40, 500],
  briefing: [80, 600],
};

const MODE_INSTRUCTIONS: Record<ResponseMode, string> = {
  direct: `Answer immediately. Use one or two sentences unless a short list materially improves clarity. Preserve the fact, caveat and next step; omit scene-setting and a closing offer.`,
  executive: `Lead with the recommendation or priority. Explain the material evidence, consequence, trade-off and next decision. Distinguish confirmed facts from judgement. State what can wait. Use short headings only when they make the decision easier to scan.`,
  draft: `Return the proposed communication itself, with only the context needed to review it. Match the relationship and requested tone. Preserve the Director's meaning and level of commitment. Do not add promises, deadlines, warmth or formality that were not requested.`,
  action_preview: `State that the action is prepared, not completed. Show every material target and consequence exactly once. Keep the confirmation request concrete and use the required Yes or No sentence verbatim.`,
  action_result: `Lead with the verified outcome in one plain sentence. Mention only a material qualification or safe recovery step. Never add celebration or claim more than the execution evidence proves.`,
  error: `Say what could not be completed, whether anything changed, and the safest next step. Distinguish a confirmed failure from an unknown outcome. Do not expose technical internals or retry an uncertain mutation.`,
  sensitive: `Be measured and candid. Acknowledge the specific human consequence without generic sympathy. Give a clear recommendation, its basis and the least risky next step. Disagree respectfully when that protects the Director.`,
  briefing: `Open with the state of the day, not an introduction. Rank only evidence-backed matters. For each item say who or what, what is needed, when if stated, and why it matters. Separate follow-ups and end with what can wait when supported.`,
};

/**
 * A deterministic first-pass classification. This chooses presentation and
 * model policy only; it never grants tools, changes risk, or authorises work.
 */
export function classifyResponseMode(message: string): ResponseMode {
  const text = message.trim().toLowerCase();

  if (/\b(draft|write|compose|word)\b.{0,40}\b(email|reply|message|letter)\b|\b(email|reply|message|letter)\b.{0,40}\b(draft|write|compose|word)\b/.test(text)) {
    return 'draft';
  }
  if (/\b(sensitive|confidential|delicate|personal|grievance|bereavement|disciplinary|legal|reputation|reputational)\b/.test(text)) {
    return 'sensitive';
  }
  if (
    text.length > 500 ||
    (text.match(/\?/g)?.length ?? 0) > 1 ||
    /\b(report|briefing|prioriti[sz]e|recommend|decision|trade-?off|what needs my attention|what matters|compare|analyse|analyze|strategy)\b/.test(text)
  ) {
    return 'executive';
  }
  return 'direct';
}

export function responsePolicy(
  mode: ResponseMode,
  adaptiveLimitsEnabled = env.HERMES_RESPONSE_MODES,
): ResponsePolicy {
  const legacyLimit = mode === 'briefing' ? 500 : 800;
  return {
    mode,
    maxTokens: adaptiveLimitsEnabled ? ADAPTIVE_LIMITS[mode] : legacyLimit,
    adaptiveLimitsEnabled,
    expectsRecommendation: mode === 'executive' || mode === 'sensitive' || mode === 'briefing',
    requiresActionEvidence: mode === 'action_preview' || mode === 'action_result',
    targetWords: TARGET_WORDS[mode],
  };
}

/** Compact, mode-specific writing contract injected once per turn. */
export function responseModeBlock(mode: ResponseMode): string {
  const [minimum, maximum] = TARGET_WORDS[mode];
  return `RESPONSE MODE: ${mode.toUpperCase()}\n${MODE_INSTRUCTIONS[mode]}\nTypical length: ${minimum}-${maximum} words. Use the length the request actually needs; this is guidance, not a quota.`;
}
