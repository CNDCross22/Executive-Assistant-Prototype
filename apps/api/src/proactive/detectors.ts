import { createHash } from 'node:crypto';
import type { CalendarEvent } from '../graph/calendar.service.js';
import type { DashboardData } from '../dashboard/service.js';
import { findCalendarConflicts } from '../calendar/intelligence.js';
import { formatInZone } from '../lib/timezone.js';
import type { DetectedProactiveEvent, ProactiveSeverity } from './types.js';

function hash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

function safeText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function expiry(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

function eventBase(userId: string, type: DetectedProactiveEvent['type'], sourceRef: string, version: string) {
  return { userId, type, sourceRef, dedupeKey: hash(userId, type, sourceRef), sourceVersion: hash(type, sourceRef, version) };
}

function mailSeverity(item: DashboardData['needsYou'][number], now: Date): ProactiveSeverity {
  if (item.warning) return 'critical';
  if (item.statedDeadline?.parsedDate) {
    const due = Date.parse(`${item.statedDeadline.parsedDate}T23:59:59Z`);
    if (Number.isFinite(due) && due <= now.getTime() + 24 * 3_600_000) return 'critical';
  }
  if (item.importance === 'high' || item.decisionRequired || item.priorityScore >= 70) return 'high';
  return 'normal';
}

export function detectProactiveEvents(input: {
  userId: string;
  timezone: string;
  dashboard: DashboardData;
  calendar: CalendarEvent[];
  now?: Date;
}): DetectedProactiveEvent[] {
  const now = input.now ?? new Date();
  const events: DetectedProactiveEvent[] = [];

  for (const item of input.dashboard.needsYou) {
    const from = safeText(item.from, 80);
    const subject = safeText(item.subject, 140);
    const severity = mailSeverity(item, now);
    if (item.warning) {
      events.push({
        ...eventBase(input.userId, 'security_warning', item.id, `${item.receivedAt}:${item.warning}`),
        severity, confidence: 0.98, title: `Review a suspicious message from ${from}`,
        summary: `${subject} was flagged as potentially unsafe. Nothing has been acted on.`,
        recommendation: 'Inspect it carefully before replying, forwarding, or opening links.',
        evidence: ['The message matched the existing suspicious-content checks.'], actionLink: item.webLink || null,
        effectiveAt: item.receivedAt || null, expiresAt: expiry(now, 72),
      });
      continue;
    }
    if (severity === 'high' || severity === 'critical') {
      const fact = item.request ? safeText(item.request, 180) : `${from} sent ${subject}.`;
      const deadline = item.statedDeadline ? ` Stated deadline: ${safeText(item.statedDeadline.statedText, 80)}.` : ' There is no stated deadline.';
      events.push({
        ...eventBase(input.userId, 'email_attention', item.id, `${item.receivedAt}:${item.priorityScore}:${item.request ?? ''}`),
        severity, confidence: 0.9, title: `${from} needs your attention`, summary: `${fact}${deadline}`,
        recommendation: safeText(item.recommendation.reason, 220), evidence: item.reasons.slice(0, 4).map((reason) => safeText(reason, 120)),
        actionLink: item.webLink || null, effectiveAt: item.statedDeadline?.parsedDate ?? item.receivedAt ?? null, expiresAt: expiry(now, 72),
      });
    }
  }

  for (const item of input.dashboard.owedByYou.filter((candidate) => candidate.daysWaiting >= 3)) {
    const person = safeText(item.person, 80);
    events.push({
      ...eventBase(input.userId, 'overdue_reply', item.conversationId || `${person}:${item.subject}`, `${item.lastMessageAt ?? ''}:${item.daysWaiting}`),
      severity: item.daysWaiting >= 7 ? 'high' : 'normal', confidence: 0.95,
      title: `${person} is waiting for your reply`, summary: `${safeText(item.subject, 160)} has been waiting ${item.daysWaiting} days.`,
      recommendation: 'Review the thread and decide whether to reply or close the loop.', evidence: [`The latest thread state indicates you owe the reply.`, `Waiting ${item.daysWaiting} days.`],
      actionLink: item.webLink || null, effectiveAt: null, expiresAt: expiry(now, 48),
    });
  }

  for (const item of input.dashboard.waitingOnThem.filter((candidate) => candidate.daysWaiting >= 5)) {
    const person = safeText(item.person, 80);
    events.push({
      ...eventBase(input.userId, 'overdue_follow_up', item.conversationId || `${person}:${item.subject}`, `${item.lastMessageAt ?? ''}:${item.daysWaiting}`),
      severity: item.daysWaiting >= 10 ? 'high' : 'normal', confidence: 0.9,
      title: `Consider following up with ${person}`, summary: `${safeText(item.subject, 160)} has had no reply for ${item.daysWaiting} days.`,
      recommendation: 'Check whether the matter still needs a response before following up.', evidence: [`The latest thread state indicates you are waiting on them.`, `Waiting ${item.daysWaiting} days.`],
      actionLink: item.webLink || null, effectiveAt: null, expiresAt: expiry(now, 72),
    });
  }

  const activeCalendar = input.calendar.filter((item) => !item.isCancelled);
  for (let index = 0; index < activeCalendar.length; index++) {
    const current = activeCalendar[index]!;
    const conflicts = findCalendarConflicts({ start: current.start, end: current.end, timezone: input.timezone }, activeCalendar, current.id)
      .filter((candidate) => candidate.id.localeCompare(current.id) > 0);
    for (const conflict of conflicts) {
      const ids = [current.id, conflict.id].sort();
      events.push({
        ...eventBase(input.userId, 'calendar_conflict', ids.join(':'), `${current.start}:${current.end}:${conflict.start}:${conflict.end}`),
        severity: 'high', confidence: 1, title: 'Two calendar events overlap',
        summary: `${safeText(current.subject, 100)} conflicts with ${safeText(conflict.subject, 100)}.`,
        recommendation: 'Review the clash. No meeting has been moved or cancelled.', evidence: [`Overlap starts ${formatInZone(new Date(Math.max(Date.parse(current.start), Date.parse(conflict.start))), input.timezone, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`],
        actionLink: current.webLink || null, effectiveAt: current.start,
        expiresAt: current.end.localeCompare(conflict.end) >= 0 ? current.end : conflict.end,
      });
    }
  }

  const horizon = now.getTime() + 24 * 3_600_000;
  for (const item of activeCalendar) {
    const starts = Date.parse(item.start);
    if (!Number.isFinite(starts) || starts <= now.getTime() || starts > horizon || item.isAllDay) continue;
    const hours = (starts - now.getTime()) / 3_600_000;
    events.push({
      ...eventBase(input.userId, 'upcoming_meeting', item.id, `${item.start}:${item.end}:${item.subject}`),
      severity: hours <= 2 ? 'high' : 'normal', confidence: 1,
      title: `${safeText(item.subject, 140)} is coming up`,
      summary: `It starts ${formatInZone(new Date(starts), input.timezone, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.`,
      recommendation: hours <= 2 ? 'Check whether you need any material before it starts.' : null,
      evidence: [`Calendar start: ${item.start}.`], actionLink: item.webLink || null, effectiveAt: item.start,
      expiresAt: item.end || expiry(now, 24),
    });
  }

  return events;
}
