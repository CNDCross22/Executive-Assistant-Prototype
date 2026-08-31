export type RequestOperation = 'read' | 'write' | 'conversation';
export type RequestDomain = 'mail' | 'calendar' | 'tasks' | 'contacts' | 'memory' | 'general';
export type RequestGoal = 'mail_summary' | 'mail_lookup' | 'calendar' | 'task' | 'contact' | 'memory' | 'general';

export interface RequestIntent {
  operation: RequestOperation;
  domain: RequestDomain;
  goal: RequestGoal;
  /** Internal routing language only. It contains no user or external content. */
  routingHint: string;
  reason: string;
}

interface IntentTurn {
  role: 'user' | 'assistant';
  content: string;
}

const MAIL_WORDS = /\b(?:email|emails|mail|mailbox|inbox|message|messages)\b/i;
const SUMMARY_WORDS = /\b(?:summary|summarise|summarize|overview|catch me up|whole summary|full summary)\b/i;

/**
 * Interpret the requested outcome before selecting any tools.
 *
 * This is deliberately deterministic. It is a safety and routing boundary,
 * not a substitute for the model's semantic work after the allowed tool set
 * has been selected. Ambiguity defaults to read-only capability.
 */
export function interpretRequest(message: string, history: IntentTurn[] = []): RequestIntent {
  const text = message.trim();
  const recent = history.slice(-6).map((turn) => turn.content).join('\n');
  const context = `${text}\n${recent}`;

  const asksForDisplayedReport =
    /\b(?:give|show|send) me\b.{0,60}\b(?:summary|overview|report|list|details|information)\b/i.test(text) ||
    /\b(?:read|check) (?:them|these|those|my emails?|my mail|the inbox)\b/i.test(text) ||
    (SUMMARY_WORDS.test(text) && MAIL_WORDS.test(context));
  const namesExternalDestination = /\bsend\b.{0,80}\bto\s+(?!me\b)/i.test(text);
  const alsoRequestsMutation = /\b(?:reply|respond|forward|draft|compose|delete|archive|move|flag|unflag|mark read|mark unread)\b/i.test(text);
  const mailSummary = asksForDisplayedReport && MAIL_WORDS.test(context) && !namesExternalDestination && !alsoRequestsMutation;
  if (mailSummary) {
    return {
      operation: 'read', domain: 'mail', goal: 'mail_summary',
      routingHint: 'inbox email summary catch up',
      reason: 'The Director asked for mailbox information to be displayed in this conversation.',
    };
  }

  const writePatterns = [
    /\b(?:reply|respond|forward|draft|compose)\b/i,
    /\bsend\b.{0,80}\b(?:email|mail|message|reply|draft)\b/i,
    /\bsend\s+(?:it|this|that|them)\b/i,
    /\bsend\b.{0,80}\bto\s+(?!me\b)/i,
    /\b(add|remove|invite)\b.{0,60}\b(attendee|guest|participant)s?\b/i,
    /\b(add|append|update|change|edit|set|replace)\b.{0,60}\b(note|notes|description|details|body)\b/i,
    /\b(create|add|book|schedule|reschedule|update|edit|change|move|remove|delete|cancel|accept|decline|tentatively accept)\b.{0,60}\b(calendar|event|meeting|appointment|invitation)s?\b/i,
    /\b(create|add|update|edit|change|complete|delete|remove)\b.{0,60}\b(task|reminder|to-do|todo)s?\b/i,
    /\b(create|add|update|edit|change|delete|remove)\b.{0,60}\bcontact\b/i,
    /\b(mark|flag|unflag|archive|move|delete)\b.{0,60}\b(email|mail|message|it|this|that)\b/i,
    /\b(turn on|turn off|enable|disable|set|update|change)\b.{0,60}\b(out of office|automatic repl|auto.?repl|working hours|mailbox setting)\b/i,
    /\b(remember|forget)\b.{0,80}\b(this|that|my|preference|memory|rule|fact|person)\b/i,
  ];
  if (writePatterns.some((pattern) => pattern.test(text))) {
    const domain: RequestDomain = /\b(calendar|event|meeting|appointment|invitation)\b/i.test(text) ? 'calendar'
      : /\b(task|reminder|to-do|todo)\b/i.test(text) ? 'tasks'
        : /\bcontact\b/i.test(text) ? 'contacts'
          : /\b(remember|forget|preference|memory)\b/i.test(text) ? 'memory' : 'mail';
    const goal: RequestGoal = domain === 'calendar' ? 'calendar' : domain === 'tasks' ? 'task'
      : domain === 'contacts' ? 'contact' : domain === 'memory' ? 'memory' : 'mail_lookup';
    return { operation: 'write', domain, goal, routingHint: `${domain} change`, reason: 'The request explicitly asks for a data-changing action.' };
  }

  if (MAIL_WORDS.test(context)) {
    return { operation: 'read', domain: 'mail', goal: 'mail_lookup', routingHint: 'email inbox read', reason: 'The request concerns mailbox information and contains no explicit mutation.' };
  }
  if (/\b(calendar|diary|meeting|appointment)\b/i.test(context)) {
    return { operation: 'read', domain: 'calendar', goal: 'calendar', routingHint: 'calendar diary read', reason: 'The request concerns calendar information and contains no explicit mutation.' };
  }

  return { operation: 'conversation', domain: 'general', goal: 'general', routingHint: '', reason: 'No external data change was explicitly requested.' };
}

export function requestIntentBlock(intent: RequestIntent): string {
  const permission = intent.operation === 'write'
    ? 'Read tools and the relevant validated write tools may be used. Any write still requires the code-generated approval.'
    : 'Only read-only tools are available. Answer in this conversation; do not prepare or imply an external change.';
  return `Operation: ${intent.operation.toUpperCase()}\nDomain: ${intent.domain}\nGoal: ${intent.goal}\n${permission}`;
}
