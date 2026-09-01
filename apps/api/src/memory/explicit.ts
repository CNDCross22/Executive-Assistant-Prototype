import type { MemoryScope, MemoryType } from './store.js';

export interface ExplicitMemory {
  type: Exclude<MemoryType, 'historical'>;
  title: string;
  content: string;
  key: string;
  importance: number;
  scope: MemoryScope;
  scopeRef?: string;
  expiresAt?: string;
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '').trim();
}

function capitalise(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function keyFor(type: ExplicitMemory['type'], value: string): string {
  if (/\b(emails?|mails?|repl(?:y|ies)|messages?|drafts?)\b/i.test(value) && /\b(short|concise|brief|detailed|detail|long|length)\b/i.test(value)) {
    return 'preference.communication.detail';
  }
  if (/\b(emails?|mails?|repl(?:y|ies)|messages?|drafts?|communications?)\b/i.test(value) && /\b(formal|casual|warm|direct|tone)\b/i.test(value)) {
    return 'preference.communication.tone';
  }
  if (/\b(meeting|calendar|schedule|booking|appointment)\b/i.test(value) && /\b(before|after|earliest|latest|am|pm)\b/i.test(value)) {
    return 'operational.calendar.hours';
  }
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 60);
  return type + '.' + (slug || 'director-rule');
}

/** Parse only unmistakable first-person preferences and standing instructions. */
function expiryFrom(message: string, now: Date): string | undefined {
  const count = message.match(/\bfor (?:the )?next (\d{1,3}) (days?|weeks?|months?)\b/i);
  if (count) {
    const amount = Number(count[1]);
    const unit = count[2]!.toLowerCase();
    const expiry = new Date(now);
    if (unit.startsWith('day')) expiry.setUTCDate(expiry.getUTCDate() + amount);
    else if (unit.startsWith('week')) expiry.setUTCDate(expiry.getUTCDate() + amount * 7);
    else expiry.setUTCMonth(expiry.getUTCMonth() + amount);
    return expiry.toISOString();
  }
  if (/\bthis month\b/i.test(message)) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  const until = message.match(/\buntil (\d{4}-\d{2}-\d{2})\b/i);
  if (until) {
    const expiry = new Date(`${until[1]}T23:59:59.999Z`);
    if (!Number.isNaN(expiry.getTime()) && expiry > now) return expiry.toISOString();
  }
  return undefined;
}

function scopeFrom(body: string): { scope: MemoryScope; scopeRef?: string } {
  const specific = body.match(/^for\s+([^,]{2,80})\s*,\s*/i);
  if (specific) return { scope: 'communication', scopeRef: clean(specific[1]!).toLowerCase() };
  if (/\b(meeting|calendar|schedule|booking|appointment)\b/i.test(body)) return { scope: 'calendar' };
  if (/\b(emails?|mails?|repl(?:y|ies)|messages?|drafts?|subject lines?)\b/i.test(body)) return { scope: 'email' };
  return { scope: 'global' };
}

export function parseExplicitMemory(message: string, now = new Date()): ExplicitMemory | null {
  const original = clean(message.replace(/[.!?]+$/g, ''));
  if (!original) return null;

  const rules: Array<{
    pattern: RegExp;
    type: ExplicitMemory['type'];
    title: (body: string) => string;
    content: (body: string) => string;
    importance?: number;
  }> = [
    {
      pattern: /^remember\s+(?:that\s+)?(.+)$/i,
      type: 'preference',
      title: (body) => capitalise(body),
      content: (body) => capitalise(body),
    },
    {
      pattern: /^i (?:strongly )?prefer\s+(.+)$/i,
      type: 'preference',
      title: (body) => 'Prefers ' + body,
      content: (body) => 'The user prefers ' + body + '.',
    },
    {
      pattern: /^my preference is\s+(.+)$/i,
      type: 'preference',
      title: (body) => 'Prefers ' + body,
      content: (body) => 'The user prefers ' + body + '.',
    },
    {
      pattern: /^from now on,?\s+(.+)$/i,
      type: 'operational',
      title: (body) => capitalise(body),
      content: (body) => capitalise(body),
      importance: 4,
    },
    {
      pattern: /^i want you to\s+(always|never)\s+(.+)$/i,
      type: 'operational',
      title: (body) => capitalise(body),
      content: (body) => capitalise(body),
      importance: 4,
    },
    {
      pattern: /^please\s+(always|never)\s+(.+)$/i,
      type: 'operational',
      title: (body) => capitalise(body),
      content: (body) => capitalise(body),
      importance: 4,
    },
    {
      pattern: /^(always|never)\s+(.+)$/i,
      type: 'operational',
      title: (body) => capitalise(body),
      content: (body) => capitalise(body),
      importance: 4,
    },
    {
      pattern: /^(?:do not|don't)\s+(.+)$/i,
      type: 'operational',
      title: (body) => 'Do not ' + body,
      content: (body) => 'Do not ' + body,
      importance: 4,
    },
    {
      pattern: /^(for\s+[^,]{2,80}\s*,\s*.+)$/i,
      type: 'preference',
      title: (body) => capitalise(body),
      content: (body) => capitalise(body),
      importance: 4,
    },
  ];

  for (const rule of rules) {
    const match = original.match(rule.pattern);
    if (!match) continue;
    const body = clean(match.slice(1).filter(Boolean).join(' '));
    if (body.length < 3) return null;
    if (/\b(?:and then|then|also)\s+(?:send|book|schedule|delete|reply|forward|create)\b/i.test(body)) return null;
    const content = clean(rule.content(body)).replace(/\.?$/, '.');
    const title = clean(rule.title(body)).slice(0, 120);
    const scoped = scopeFrom(body);
    const expiresAt = expiryFrom(original, now);
    return {
      type: rule.type,
      title,
      content,
      key: keyFor(rule.type, body),
      importance: rule.importance ?? 3,
      scope: rule.type === 'operational' && scoped.scope === 'global' ? 'operational' : scoped.scope,
      ...(scoped.scopeRef ? { scopeRef: scoped.scopeRef } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  return null;
}
