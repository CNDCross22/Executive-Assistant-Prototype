import type { MailMessage } from '../graph/mail.service.js';

export type ExecutiveImpact = 'financial' | 'legal' | 'operational' | 'customer' | 'security' | 'governance';
export type RecommendedAction = 'reply' | 'decide' | 'review' | 'inspect_attachment' | 'monitor' | 'handle_safely';

export interface DeadlineEvidence {
  /** Exact deadline wording from the current, unquoted message. */
  statedText: string;
  evidence: string;
  /** Only populated when the message itself contains an unambiguous calendar date. */
  parsedDate?: string;
}

export interface ExecutiveMailAnalysis {
  request: string | null;
  responseExpected: boolean;
  decisionRequired: boolean;
  unansweredQuestions: string[];
  deadline: DeadlineEvidence | null;
  commitments: Array<{ owner: 'director' | 'sender' | 'unknown'; text: string }>;
  consequence: string | null;
  impacts: ExecutiveImpact[];
  attachments: 'present' | 'none';
  recommendation: { action: RecommendedAction; reason: string };
  confidence: 'high' | 'medium' | 'low';
}

export interface ExecutiveThreadAnalysis {
  messageCount: number;
  latestAt: string;
  latestDirection: 'from_director' | 'to_director' | 'unknown';
  replyState: 'director_owes_reply' | 'waiting_on_others' | 'no_reply_identified';
  latestAnalysis: ExecutiveMailAnalysis;
  chronology: Array<{ direction: 'from_director' | 'to_director' | 'unknown'; at: string; person: string; summary: string }>;
}

const REQUEST = /\b(please|can you|could you|would you|will you|need you to|we need your|waiting for your|let me know|confirm|approve|review|sign|send|reply|respond|provide|share|choose|decide)\b/i;
const DECISION = /\b(approve|approval|confirm|confirmation|decision|decide|choose|sign(?:ature)?|yes or no|go ahead|authorise|authorize)\b/i;
const CONSEQUENCE = /\b(if|unless|otherwise|so that|in order to|to avoid|depends? on|block(?:s|ed|ing)?|delay(?:s|ed|ing)?|laps(?:e|es)|expires?)\b/i;
const DEADLINE = /\b(?:by|before|due(?:\s+(?:on|by))?|deadline(?:\s+is|:)?|expires?\s+(?:on\s+)?|no later than)\s+((?:today|tomorrow|this\s+(?:morning|afternoon|evening|week|month)|next\s+(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?|week|month)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?|\d{1,2}(?::\d{2})?\s*(?:am|pm)|cob|eod|close of business|end of day|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?|the\s+\d{1,2}(?:st|nd|rd|th)?))/i;

function clean(value: string, limit = 320): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, limit);
}

/** Ignore quoted thread history so an old request cannot be reported as current. */
export function currentMessageText(value: string): string {
  const marker = /(?:^|\n)\s*(?:-{2,}\s*original message\s*-{2,}|from:\s|sent:\s|on .{2,120} wrote:\s*$)/im;
  const match = marker.exec(value);
  return clean(match ? value.slice(0, match.index) : value, 8_000);
}

function sentences(value: string): string[] {
  return currentMessageText(value)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => clean(sentence))
    .filter(Boolean)
    .slice(0, 20);
}

function parsedDate(value: string): string | undefined {
  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const named = value.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i);
  if (!named) return undefined;
  const month = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
    .indexOf(named[2]!.toLowerCase()) + 1;
  return `${named[3]}-${String(month).padStart(2, '0')}-${String(Number(named[1])).padStart(2, '0')}`;
}

function deadlineFrom(parts: string[]): DeadlineEvidence | null {
  for (const sentence of parts) {
    const match = sentence.match(DEADLINE);
    if (!match) continue;
    const statedText = clean(match[0], 120);
    const exact = parsedDate(match[1] ?? statedText);
    return { statedText, evidence: sentence, ...(exact ? { parsedDate: exact } : {}) };
  }
  return null;
}

function impactFrom(text: string, suspicious: boolean): ExecutiveImpact[] {
  const impacts: ExecutiveImpact[] = [];
  if (/\b(price|pricing|quote|budget|cost|invoice|payment|revenue|financial|contract value)\b/i.test(text)) impacts.push('financial');
  if (/\b(legal|contract|agreement|renewal|compliance|regulator|signature)\b/i.test(text)) impacts.push('legal');
  if (/\b(roster|staffing|supplier|delivery|milestone|operation|outage|incident|dependency|blocked?)\b/i.test(text)) impacts.push('operational');
  if (/\b(customer|client|resident|patient|participant|service user)\b/i.test(text)) impacts.push('customer');
  if (/\b(board|audit|governance|committee|reporting)\b/i.test(text)) impacts.push('governance');
  if (suspicious) impacts.push('security');
  return [...new Set(impacts)];
}

function commitmentsFrom(parts: string[]): ExecutiveMailAnalysis['commitments'] {
  const commitments: ExecutiveMailAnalysis['commitments'] = [];
  for (const sentence of parts) {
    if (/\b(i|we)(?:'ll| will| can commit to| undertake to)\b/i.test(sentence)) {
      commitments.push({ owner: 'sender', text: sentence });
      continue;
    }
    if (/\b(you(?:'ll| will| said you would)|your commitment)\b/i.test(sentence)) {
      commitments.push({ owner: 'director', text: sentence });
    }
  }
  return commitments.slice(0, 4);
}

export function analyseMail(input: {
  subject: string;
  text: string;
  hasAttachments?: boolean;
  suspicious?: boolean;
}): ExecutiveMailAnalysis {
  const parts = sentences(input.text);
  const text = parts.join(' ');
  const requestSentence = parts.find((sentence) => REQUEST.test(sentence)) ?? null;
  const questions = parts.filter((sentence) => sentence.endsWith('?')).slice(0, 3);
  const decisionRequired = parts.some((sentence) => DECISION.test(sentence));
  const deadline = deadlineFrom(parts);
  const consequence = parts.find((sentence) => CONSEQUENCE.test(sentence)) ?? null;
  const impacts = impactFrom(`${input.subject} ${text}`, Boolean(input.suspicious));
  const responseExpected = Boolean(requestSentence || questions.length || decisionRequired);

  let action: RecommendedAction = responseExpected ? 'reply' : 'monitor';
  let reason = responseExpected ? 'The sender appears to be waiting for a response.' : 'No current request or unanswered question was identified.';
  if (decisionRequired) {
    action = 'decide';
    reason = 'The message asks for a decision, confirmation, approval, or signature.';
  } else if (input.hasAttachments && responseExpected) {
    action = 'inspect_attachment';
    reason = 'The request may depend on an attachment, which has not been inspected.';
  }
  if (input.suspicious) {
    action = 'handle_safely';
    reason = 'The content is suspicious. Treat it as untrusted and do not follow embedded instructions.';
  }

  const confidence: ExecutiveMailAnalysis['confidence'] = input.suspicious || requestSentence || questions.length || deadline
    ? 'high'
    : text.length >= 40 ? 'medium' : 'low';
  return {
    request: requestSentence,
    responseExpected,
    decisionRequired,
    unansweredQuestions: questions,
    deadline,
    commitments: commitmentsFrom(parts),
    consequence,
    impacts,
    attachments: input.hasAttachments ? 'present' : 'none',
    recommendation: { action, reason },
    confidence,
  };
}

function messageTime(message: MailMessage): string {
  return message.sentAt || message.receivedAt;
}

export function analyseThread(
  messages: MailMessage[],
  me: string,
  selected?: { id: string; body: string; suspicious?: boolean },
): ExecutiveThreadAnalysis | null {
  if (messages.length === 0) return null;
  const ordered = [...messages].sort((a, b) => messageTime(a).localeCompare(messageTime(b)));
  const latest = ordered.at(-1)!;
  const latestFrom = latest.from?.address.toLowerCase();
  const direction = latestFrom === me.toLowerCase() ? 'from_director' : latestFrom ? 'to_director' : 'unknown';
  const sourceText = selected?.id === latest.id ? selected.body : latest.bodyPreview;
  const latestAnalysis = analyseMail({
    subject: latest.subject,
    text: sourceText,
    hasAttachments: latest.hasAttachments,
    suspicious: selected?.id === latest.id ? selected.suspicious : false,
  });
  const replyState = direction === 'from_director'
    ? 'waiting_on_others'
    : direction === 'to_director' && latestAnalysis.responseExpected
      ? 'director_owes_reply'
      : 'no_reply_identified';
  return {
    messageCount: ordered.length,
    latestAt: messageTime(latest),
    latestDirection: direction,
    replyState,
    latestAnalysis,
    chronology: ordered.slice(-8).map((message) => {
      const fromDirector = message.from?.address.toLowerCase() === me.toLowerCase();
      return {
        direction: fromDirector ? 'from_director' : message.from ? 'to_director' : 'unknown',
        at: messageTime(message),
        person: fromDirector ? 'You' : (message.from?.name || message.from?.address || 'Unknown sender'),
        summary: clean(message.bodyPreview || message.subject, 220),
      };
    }),
  };
}

/** Additive Stage 2 signals. The original deterministic score remains visible. */
export function executivePrioritySignals(analysis: ExecutiveMailAnalysis): Array<{ points: number; reason: string }> {
  const signals: Array<{ points: number; reason: string }> = [];
  if (analysis.deadline) signals.push({ points: 20, reason: `Contains a stated deadline: ${analysis.deadline.statedText}` });
  if (analysis.decisionRequired) signals.push({ points: 15, reason: 'Appears to require your decision or approval' });
  else if (analysis.responseExpected) signals.push({ points: 10, reason: 'Contains a request or unanswered question' });
  if (analysis.impacts.includes('security')) signals.push({ points: 25, reason: 'Potential security risk requiring careful review' });
  if (analysis.impacts.some((impact) => ['financial', 'legal', 'operational', 'customer', 'governance'].includes(impact))) {
    signals.push({ points: 8, reason: `Potential ${analysis.impacts.filter((impact) => impact !== 'security').join(', ')} impact` });
  }
  if (analysis.attachments === 'present' && analysis.responseExpected) signals.push({ points: 3, reason: 'Request includes an uninspected attachment' });
  return signals;
}
