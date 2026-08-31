import { toIana } from '../lib/timezone.js';
import type { ProactiveEvent, ProactiveEventType, ProactivePolicy, ProactiveSeverity } from './types.js';

const SEVERITY: Record<ProactiveSeverity, number> = { low: 0, normal: 1, high: 2, critical: 3 };

const DEFAULTS: Record<ProactiveEventType, Pick<ProactivePolicy, 'enabled' | 'outcome' | 'minimumSeverity' | 'cooldownMinutes' | 'dailyCap'>> = {
  security_warning: { enabled: true, outcome: 'notify', minimumSeverity: 'high', cooldownMinutes: 1_440, dailyCap: 4 },
  email_attention: { enabled: true, outcome: 'recommend', minimumSeverity: 'high', cooldownMinutes: 720, dailyCap: 5 },
  overdue_reply: { enabled: true, outcome: 'recommend', minimumSeverity: 'normal', cooldownMinutes: 1_440, dailyCap: 4 },
  overdue_follow_up: { enabled: true, outcome: 'notify', minimumSeverity: 'normal', cooldownMinutes: 2_880, dailyCap: 3 },
  calendar_conflict: { enabled: true, outcome: 'recommend', minimumSeverity: 'high', cooldownMinutes: 720, dailyCap: 4 },
  upcoming_meeting: { enabled: true, outcome: 'notify', minimumSeverity: 'normal', cooldownMinutes: 720, dailyCap: 4 },
};

export function defaultPolicy(userId: string, eventType: ProactiveEventType, timezone: string, now = new Date()): ProactivePolicy {
  const stamp = now.toISOString();
  return {
    id: crypto.randomUUID(), userId, eventType, ...DEFAULTS[eventType],
    quietStart: '22:00', quietEnd: '07:00', timezone: toIana(timezone),
    confirmedAt: stamp, updatedAt: stamp,
  };
}

function localClock(now: Date, timezone: string): { minutes: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: toIana(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00';
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

function clockMinutes(value: string): number {
  const [hour = 0, minute = 0] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function localDay(now: Date, timezone: string): string {
  return localClock(now, timezone).day;
}

export function isQuietHours(now: Date, policy: Pick<ProactivePolicy, 'quietStart' | 'quietEnd' | 'timezone'>): boolean {
  if (!policy.quietStart || !policy.quietEnd || policy.quietStart === policy.quietEnd) return false;
  const current = localClock(now, policy.timezone).minutes;
  const start = clockMinutes(policy.quietStart);
  const end = clockMinutes(policy.quietEnd);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function meetsThreshold(event: Pick<ProactiveEvent, 'severity'>, policy: Pick<ProactivePolicy, 'minimumSeverity'>): boolean {
  return SEVERITY[event.severity] >= SEVERITY[policy.minimumSeverity];
}
