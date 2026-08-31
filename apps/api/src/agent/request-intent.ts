import type { RiskLevel, ToolCategory } from './tools/types.js';

export type RequestOperation = 'read' | 'write' | 'conversation';
export type RequestDomain =
  | 'mail' | 'calendar' | 'tasks' | 'contacts' | 'memory' | 'mailbox_settings'
  | 'identity' | 'teams' | 'files' | 'sharepoint' | 'mixed' | 'general';
export type RequestGoal =
  | 'mail_summary' | 'mail_lookup' | 'calendar_summary' | 'calendar'
  | 'task' | 'contact' | 'memory' | 'mailbox_settings' | 'identity'
  | 'teams' | 'files' | 'sharepoint' | 'mixed' | 'general';

export interface RequestIntent {
  operation: RequestOperation;
  domain: RequestDomain;
  domains: Exclude<RequestDomain, 'mixed' | 'general'>[];
  goal: RequestGoal;
  routingHint: string;
  reason: string;
}

interface IntentTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface IntentTool {
  name: string;
  riskLevel: RiskLevel;
  metadata: { category: ToolCategory };
}

const SUMMARY_WORDS = /\b(?:summary|summarise|summarize|overview|catch me up|whole summary|full summary)\b/i;
const REFERENCE_WORDS = /\b(?:it|that|them|those|these|same|there|again|also|as well|what about|how about|the earlier|the previous)\b/i;

const DOMAIN_PATTERNS: Array<[Exclude<RequestDomain, 'mixed' | 'general'>, RegExp]> = [
  ['mailbox_settings', /\b(?:out of office|automatic repl(?:y|ies)|auto.?repl(?:y|ies)|working hours|mailbox settings?|outlook time ?zone)\b/i],
  ['sharepoint', /\b(?:sharepoint|site collection|team site)\b/i],
  ['teams', /\b(?:microsoft teams|teams? channel|channel messages?|joined teams?)\b/i],
  ['files', /\b(?:onedrive|my drive|drive files?|cloud files?)\b/i],
  ['calendar', /\b(?:calendar|diary|agenda|meeting|meetings|event|events|appointment|appointments|invitation|invitations|free.?busy|availability|available|available slot|upcoming events?|conference call|video call)\b/i],
  ['tasks', /\b(?:task|tasks|to-do|todo|reminder|reminders|task list)\b/i],
  ['contacts', /\b(?:contact|contacts|address book|directory|phone number|mobile number|email address|colleague)\b/i],
  ['memory', /\b(?:remember|memory|memories|preference|preferences|forget what|what do you know about me)\b/i],
  ['identity', /\b(?:my profile|connected account|microsoft account|who am i|my job title)\b/i],
  ['mail', /\b(?:email|emails|e-mail|mail|mailbox|inbox|message|messages|sender|unread|attachment|attachments)\b/i],
];

function explicitDomains(text: string): RequestIntent['domains'] {
  const domains: RequestIntent['domains'] = [];
  for (const [domain, pattern] of DOMAIN_PATTERNS) {
    if (pattern.test(text) && !domains.includes(domain)) domains.push(domain);
  }
  // Generic words such as "mailbox" and "messages" occur inside more
  // specific Microsoft 365 areas. The specific area wins unless the Director
  // also names ordinary email explicitly.
  if (domains.includes('mailbox_settings')) removeDomain(domains, 'mail');
  if (domains.includes('contacts') && /\bemail address\b/i.test(text)) removeDomain(domains, 'mail');
  if (domains.includes('memory') && /\b(?:remember|preference|preferences)\b/i.test(text)) removeDomain(domains, 'mail');
  if (domains.includes('teams') && !/\b(?:email|e-mail|mail|inbox|mailbox)\b/i.test(text)) removeDomain(domains, 'mail');
  if (domains.includes('calendar') && domains.includes('tasks') &&
      /\b(?:calendar|diary|meeting|event|appointment)\b/i.test(text) &&
      !/\b(?:task|to-do|todo|task list)\b/i.test(text)) {
    removeDomain(domains, 'tasks');
  }
  if (domains.length === 0 && /\b(?:who(?:'s| is)? waiting on me|got back to me|repl(?:y|ies|ied)|respond(?:ed|ing)?|what did .{1,60} say)\b/i.test(text)) {
    domains.push('mail');
  }
  if (domains.length === 0 && /\b(?:my day|what(?:'s| is) on (?:today|tomorrow)|today(?:'s)? schedule|tomorrow(?:'s)? schedule)\b/i.test(text)) {
    domains.push('calendar');
  }
  if (domains.length === 0 && /\b(?:what needs my attention|what needs me|what should i focus on|brief me|executive briefing|today(?:'s)? priorities|what did i miss|catch me up)\b/i.test(text)) {
    domains.push('mail', 'calendar', 'tasks');
  }
  return domains;
}

function removeDomain(domains: RequestIntent['domains'], domain: RequestIntent['domains'][number]): void {
  const index = domains.indexOf(domain);
  if (index >= 0) domains.splice(index, 1);
}

function contextualDomains(history: IntentTurn[]): RequestIntent['domains'] {
  for (let index = history.length - 1; index >= Math.max(0, history.length - 8); index--) {
    const domains = explicitDomains(history[index]!.content);
    if (domains.length) return domains;
  }
  return [];
}

function asksForWrite(text: string): boolean {
  if (/\b(?:who|which|what|find|show|list)\b.{0,100}\b(?:reply|respond)\b/i.test(text) &&
      !/\b(?:draft|write|compose|send)\b/i.test(text)) {
    return false;
  }
  const patterns = [
    /^(?:please\s+)?(?:reply|respond|forward|draft|compose)\b/i,
    /\b(?:can|could|would|will) you\s+(?:please\s+)?(?:reply|respond|forward|draft|compose)\b/i,
    /\b(?:i (?:want|need) you to|please)\s+(?:reply|respond|forward|draft|compose)\b/i,
    /\b(?:and|then|also)\s+(?:reply|respond|forward|draft|compose)\b/i,
    /\bsend\b(?!\s+me\b).{0,100}\b(?:email|mail|message|reply|draft|to)\b/i,
    /\bsend\s+(?:it|this|that|them)\b/i,
    /\b(add|remove|invite)\b.{0,60}\b(attendee|guest|participant)s?\b/i,
    /\b(add|append|update|change|edit|set|replace)\b.{0,60}\b(note|notes|description|details|body)\b/i,
    /\b(create|add|book|schedule|reschedule|update|edit|change|move|remove|delete|cancel|accept|decline|tentatively accept)\b.{0,60}\b(calendar|event|meeting|appointment|invitation)s?\b/i,
    /\b(create|add|update|edit|change|complete|delete|remove)\b.{0,60}\b(task|reminder|to-do|todo)s?\b/i,
    /\b(set|create|add|update|change|remove|delete)\b.{0,60}\breminder\b/i,
    /\b(create|add|update|edit|change|delete|remove)\b.{0,60}\bcontacts?\b/i,
    /\b(mark|flag|unflag|archive|move|delete)\b.{0,60}\b(email|mail|message|it|this|that)\b/i,
    /\b(turn on|turn off|enable|disable|set|update|change)\b.{0,60}\b(out of office|automatic repl|auto.?repl|working hours|mailbox setting)\b/i,
    /^(?:please\s+)?(?:remember|forget)\b/i,
    /\b(?:create|post|send|upload|rename|edit|change|move|remove|delete)\b.{0,80}\b(?:teams? message|channel|onedrive|sharepoint|cloud file|drive file|document|site)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function goalFor(domains: RequestIntent['domains'], text: string): RequestGoal {
  if (domains.length > 1) return 'mixed';
  const domain = domains[0];
  if (!domain) return 'general';
  if (domain === 'mail') return SUMMARY_WORDS.test(text) ? 'mail_summary' : 'mail_lookup';
  if (domain === 'calendar') return SUMMARY_WORDS.test(text) || /\b(?:upcoming|what(?:'s| is) on|agenda)\b/i.test(text) ? 'calendar_summary' : 'calendar';
  if (domain === 'tasks') return 'task';
  if (domain === 'contacts') return 'contact';
  return domain;
}

/** Current-message-first interpretation. History only resolves references. */
export function interpretRequest(message: string, history: IntentTurn[] = []): RequestIntent {
  const text = message.trim();
  const currentDomains = explicitDomains(text);
  const inheritedDomains = currentDomains.length === 0 && REFERENCE_WORDS.test(text)
    ? contextualDomains(history)
    : [];
  const domains = currentDomains.length ? currentDomains : inheritedDomains;
  const operation: RequestOperation = asksForWrite(text)
    ? 'write'
    : domains.length > 0 || /[?]/.test(text) || SUMMARY_WORDS.test(text)
      ? 'read'
      : 'conversation';
  const domain: RequestDomain = domains.length > 1 ? 'mixed' : domains[0] ?? 'general';
  const goal = goalFor(domains, text);
  const routingHint = domains.length ? `${domains.join(' ')} ${goal.replaceAll('_', ' ')}` : '';
  const reason = currentDomains.length
    ? 'The current message explicitly names the requested work area.'
    : inheritedDomains.length
      ? 'The current message is referential, so the work area was inherited from the most recent relevant exchange.'
      : operation === 'write'
        ? 'A change was requested without a safely resolved work area.'
        : 'No external data change was explicitly requested.';
  return { operation, domain, domains, goal, routingHint, reason };
}

const CATEGORY_BY_DOMAIN: Record<Exclude<RequestDomain, 'mixed' | 'general'>, ToolCategory[]> = {
  mail: ['mail'],
  calendar: ['calendar'],
  tasks: ['tasks'],
  contacts: ['contacts', 'directory'],
  memory: ['memory'],
  mailbox_settings: ['mailbox_settings'],
  identity: ['identity'],
  teams: ['teams'],
  files: ['files'],
  sharepoint: ['sharepoint'],
};

/** Code-enforced capability plan. The model cannot expand this allowlist. */
export function permittedToolsForIntent(intent: RequestIntent, tools: IntentTool[]): string[] {
  if (intent.operation === 'conversation' || intent.domains.length === 0) return [];
  if (intent.goal === 'mail_summary' && intent.operation === 'read') {
    return tools.filter((tool) => tool.name === 'mail_inbox_summary').map((tool) => tool.name);
  }

  const categories = new Set<ToolCategory>();
  for (const domain of intent.domains) {
    for (const category of CATEGORY_BY_DOMAIN[domain]) categories.add(category);
    if (intent.operation === 'write' && (domain === 'mail' || domain === 'calendar')) categories.add('directory');
  }
  return tools
    .filter((tool) => categories.has(tool.metadata.category))
    .filter((tool) => intent.operation === 'write' || tool.riskLevel === 0)
    .map((tool) => tool.name);
}

export function requestIntentBlock(intent: RequestIntent): string {
  const permission = intent.operation === 'write'
    ? 'Read tools and the relevant validated write tools may be used. Any write still requires the code-generated approval.'
    : intent.operation === 'read'
      ? 'Only read-only tools are available. Answer in this conversation; do not prepare or imply an external change.'
      : 'No Microsoft 365 tool is available unless the Director makes the requested outcome clear.';
  return `Operation: ${intent.operation.toUpperCase()}\nDomain: ${intent.domain}\nGoal: ${intent.goal}\n${permission}`;
}
