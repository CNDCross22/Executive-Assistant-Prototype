/**
 * Enforcement, not instruction.
 *
 * The system prompt tells the model it cannot act and must never claim it did.
 * A small, agreeable model ignores both — it once reported six calendar
 * reminders it had invented, dated 2023, none of which existed.
 *
 * So the rule is enforced here instead. Two guards:
 *
 *   1. Before the model runs, unsupported action requests are answered
 *      honestly and instantly. The model never gets the chance to agree.
 *   2. After the model runs, any claim of having acted is checked against
 *      what actually executed. An unbacked claim never reaches the user.
 */
import type { AgentResult, AgentStep } from './orchestrator.js';

// ---------------------------------------------------- 1. capability guard ---

interface UnsupportedAction {
  test: RegExp;
  /** What she asked for, in her words. */
  what: string;
  /** What we can honestly offer instead. */
  instead: string;
}

/**
 * Plurals matter here: an earlier version required the singular and let
 * "handle the reminders" straight through — which is the exact phrasing that
 * produced six invented calendar entries.
 */
const CALENDAR_NOUN = '(reminders?|events?|meetings?|appointments?|calendar|diary|schedule)';
const MAIL_NOUN = '(emails?|messages?|mail|reply|replies|response)';

const UNSUPPORTED: UnsupportedAction[] = [
  {
    test: new RegExp(`\\b(add|create|set|put|schedule|book|make|remind)\\b.{0,30}\\b${CALENDAR_NOUN}\\b`, 'i'),
    what: 'put things in your calendar',
    instead: 'I can tell you what has deadlines attached, so you can add them yourself.',
  },
  {
    test: new RegExp(`\\b(handle|manage|sort out|take care of|deal with|do)\\b.{0,30}\\b${CALENDAR_NOUN}\\b`, 'i'),
    what: 'manage your calendar',
    instead: 'I can tell you what has deadlines attached, so you can add them yourself.',
  },
  // "reply to Michael" names a person, not a noun we can enumerate, so this
  // deliberately matches the verb alone when it is clearly an instruction.
  {
    test: /\b(reply to|respond to|answer|forward)\b\s+\w+/i,
    what: 'send or reply to email',
    instead: 'I can tell you what needs a reply and exactly what each person is asking for.',
  },
  {
    test: new RegExp(`\\b(send)\\b.{0,30}\\b${MAIL_NOUN}\\b`, 'i'),
    what: 'send email',
    instead: 'I can tell you what needs a reply and what each person is asking for.',
  },
  {
    test: new RegExp(`\\b(draft|write|compose)\\b.{0,25}\\b${MAIL_NOUN}\\b`, 'i'),
    what: 'write drafts into your mailbox',
    instead: 'I can tell you what needs answering and what they asked.',
  },
  {
    test: new RegExp(`\\b(delete|archive|move|file|mark as read|flag)\\b.{0,25}\\b${MAIL_NOUN}|\\b(delete|archive) (it|them|that)\\b`, 'i'),
    what: 'change anything in your mailbox',
    instead: 'I can only read it at the moment.',
  },
];

/**
 * Catch a request for something we cannot do, before the model can agree to it.
 * Returns null when the request is fine to pass through.
 */
export function checkCapability(message: string): AgentResult | null {
  for (const action of UNSUPPORTED) {
    if (!action.test.test(message)) continue;

    return {
      reply:
        `I cannot ${action.what} yet — I only have read access to your mailbox, ` +
        `and nothing else is switched on. ${action.instead}`,
      steps: [],
      iterations: 0,
      model: 'direct',
      durationMs: 0,
    };
  }
  return null;
}

// --------------------------------------------------------- 2. claim guard ---

/** Phrases that assert something was done to the outside world. */
const ACTION_CLAIMS: RegExp[] = [
  /\bI(?:'ve| have)?\s+(added|created|scheduled|booked|set up|set|put)\b[^.]{0,40}\b(reminder|event|meeting|calendar|diary|appointment)/i,
  /\bI(?:'ve| have)?\s+(sent|replied|responded|forwarded|emailed)\b/i,
  /\bI(?:'ve| have)?\s+(deleted|archived|moved|filed|flagged|marked)\b/i,
  /\bI(?:'ve| have)?\s+(drafted|saved)\b[^.]{0,30}\b(draft|email|reply)/i,
  /\bhere are the (reminders|events|meetings|drafts) I(?:'ve| have)\s+(added|created|made)/i,
  /\b(has been|have been|is now)\s+(added|created|scheduled|sent|booked)\b/i,
  /\b(done|sorted|all set)\b.{0,20}\b(calendar|diary|sent|added)\b/i,
];

/** Tools that genuinely change something. None exist yet. */
const WRITE_TOOLS = new Set<string>([
  // populated as write capability is added, e.g. 'mail_send', 'calendar_create_event'
]);

function anyWriteHappened(steps: AgentStep[]): boolean {
  return steps.some((s) => WRITE_TOOLS.has(s.tool) && s.status === 'success');
}

export interface ClaimCheck {
  blocked: boolean;
  reply: string;
  reason?: string;
}

/**
 * Refuse to pass on a claim of action that nothing backs up.
 *
 * This is the last gate before the Director reads it. An assistant that says
 * it did something it did not do is worse than useless — it is a liability.
 */
export function checkClaims(reply: string, steps: AgentStep[]): ClaimCheck {
  if (anyWriteHappened(steps)) return { blocked: false, reply };

  const matched = ACTION_CLAIMS.find((p) => p.test(reply));
  if (!matched) return { blocked: false, reply };

  return {
    blocked: true,
    reason: `unbacked action claim matched ${matched.source.slice(0, 40)}`,
    reply:
      'I started to tell you I had done something, and I had not — I can only read your ' +
      'mailbox at the moment, so I cannot add reminders, send replies, or change anything. ' +
      'Ask me what needs your attention and I will tell you honestly.',
  };
}
