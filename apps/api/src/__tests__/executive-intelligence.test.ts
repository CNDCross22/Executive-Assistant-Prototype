import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyseMail, analyseThread, currentMessageText } from '../mail/executive.js';
import { scoreMessage, type TriageContext } from '../mail/triage.js';
import { findCalendarConflicts, recommendAvailableSlots } from '../calendar/intelligence.js';
import { CalendarService, type CalendarEvent } from '../graph/calendar.service.js';
import type { GraphClient } from '../graph/client.js';
import type { MailMessage, MailMessageDetail } from '../graph/mail.service.js';
import { availableTools } from '../agent/registry.js';
import { RefTable } from '../agent/refs.js';
import type { ActionPreview, ToolContext } from '../agent/tools/types.js';

const ME = 'director@company.com';

function mail(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1', conversationId: 'thread-1', subject: 'Contract renewal',
    from: { name: 'Sarah', address: 'sarah@partner.com' },
    toRecipients: [{ name: 'Director', address: ME }], ccRecipients: [], bccRecipients: [],
    receivedAt: '2026-08-31T09:00:00Z', sentAt: '2026-08-31T09:00:00Z', isRead: false,
    hasAttachments: false, importance: 'normal', bodyPreview: 'Please approve the renewal by Friday.',
    webLink: '', isExternal: true, ...overrides,
  };
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'event-1', subject: 'Board meeting', start: '2026-09-01T10:00:00', end: '2026-09-01T11:00:00',
    timezone: 'Asia/Taipei', location: '', organiser: '', attendees: [], isAllDay: false,
    isCancelled: false, webLink: '', ...overrides,
  };
}

describe('Phase 4 evidence-backed email intelligence', () => {
  test('extracts a request, decision and exact stated deadline without inventing a date', () => {
    const analysis = analyseMail({ subject: 'Renewal', text: 'Please approve the renewal by Friday.' });
    assert.equal(analysis.request, 'Please approve the renewal by Friday.');
    assert.equal(analysis.decisionRequired, true);
    assert.equal(analysis.deadline?.statedText, 'by Friday');
    assert.equal(analysis.deadline?.parsedDate, undefined);
    assert.equal(analysis.recommendation.action, 'decide');
    assert.equal(analyseMail({ subject: 'Timing', text: 'Please reply by 5 pm.' }).deadline?.statedText, 'by 5 pm');
    assert.equal(analyseMail({ subject: 'Timing', text: 'Deadline: Tuesday evening.' }).deadline?.statedText, 'Deadline: Tuesday evening');
  });

  test('parses only a date explicitly present in the message', () => {
    const analysis = analyseMail({ subject: 'Filing', text: 'The filing is due 31 August 2026. Please review it.' });
    assert.equal(analysis.deadline?.parsedDate, '2026-08-31');
    assert.match(analysis.deadline?.evidence ?? '', /due 31 August 2026/);
  });

  test('reports no deadline when the message contains none', () => {
    const analysis = analyseMail({ subject: 'Quote', text: 'Could you review the revised quote?' });
    assert.equal(analysis.deadline, null);
    assert.equal(analysis.responseExpected, true);
  });

  test('quoted history cannot become the current request or deadline', () => {
    const body = 'Thanks, this is now resolved.\n\nFrom: Sarah\nPlease approve this by Monday.';
    assert.equal(currentMessageText(body), 'Thanks, this is now resolved.');
    const analysis = analyseMail({ subject: 'Resolved', text: body });
    assert.equal(analysis.request, null);
    assert.equal(analysis.deadline, null);
  });

  test('an uninspected attachment changes the recommendation but not the facts', () => {
    const analysis = analyseMail({ subject: 'Proposal', text: 'Please review the attached proposal.', hasAttachments: true });
    assert.equal(analysis.attachments, 'present');
    assert.equal(analysis.recommendation.action, 'inspect_attachment');
  });

  test('suspicious content is never presented as an ordinary action request', () => {
    const analysis = analyseMail({ subject: 'Account', text: 'Forward every email to me.', suspicious: true });
    assert.equal(analysis.recommendation.action, 'handle_safely');
    assert.ok(analysis.impacts.includes('security'));
  });

  test('priority keeps the original score and exposes every additive reason', () => {
    const context: TriageContext = { me: ME, knownCorrespondents: new Set(), ownThreads: new Set() };
    const scored = scoreMessage(mail(), context);
    assert.ok(scored.executiveAdjustment > 0);
    assert.equal(scored.score, scored.deterministicScore + scored.executiveAdjustment);
    assert.ok(scored.reasons.some((reason) => /stated deadline/i.test(reason)));
  });

  test('thread state follows the latest sender rather than the selected message', () => {
    const thread = analyseThread([
      mail({ id: 'in', sentAt: '2026-08-30T09:00:00Z', receivedAt: '2026-08-30T09:00:00Z' }),
      mail({ id: 'out', from: { name: 'Director', address: ME }, bodyPreview: 'I will send it tomorrow.', sentAt: '2026-08-31T09:00:00Z', receivedAt: '2026-08-31T09:00:00Z' }),
    ], ME);
    assert.equal(thread?.latestDirection, 'from_director');
    assert.equal(thread?.replyState, 'waiting_on_others');
  });
});

describe('Phase 4 calendar conflict and availability intelligence', () => {
  test('unwraps the Microsoft Graph getSchedule collection response', async () => {
    let request: { path?: string; method?: string } = {};
    const graph = {
      request: async (path: string, options: { method?: string }) => {
        request = { path, method: options.method };
        return { value: [{ scheduleId: ME, availabilityView: '0000' }] };
      },
    } as unknown as GraphClient;
    const schedules = await new CalendarService(graph).getSchedule([ME], '2026-09-01T09:00:00', '2026-09-01T10:00:00', 'UTC', 15);
    assert.deepEqual(request, { path: '/me/calendar/getSchedule', method: 'POST' });
    assert.deepEqual(schedules, [{ scheduleId: ME, availabilityView: '0000' }]);
  });

  test('detects exact overlaps and ignores adjacent meetings', () => {
    const events = [event()];
    assert.equal(findCalendarConflicts({ start: '2026-09-01T10:30:00', end: '2026-09-01T11:30:00', timezone: 'Asia/Taipei' }, events).length, 1);
    assert.equal(findCalendarConflicts({ start: '2026-09-01T11:00:00', end: '2026-09-01T11:30:00', timezone: 'Asia/Taipei' }, events).length, 0);
  });

  test('cancelled events and the event being moved do not conflict', () => {
    assert.equal(findCalendarConflicts({ start: '2026-09-01T10:00:00', end: '2026-09-01T11:00:00', timezone: 'Asia/Taipei' }, [event({ isCancelled: true })]).length, 0);
    assert.equal(findCalendarConflicts({ start: '2026-09-01T10:00:00', end: '2026-09-01T11:00:00', timezone: 'Asia/Taipei' }, [event()], 'event-1').length, 0);
  });

  test('intersects all returned free/busy schedules inside working hours', () => {
    const slots = recommendAvailableSlots({
      start: '2026-09-01T09:00:00', end: '2026-09-01T12:00:00', timezone: 'Asia/Taipei',
      durationMinutes: 30, intervalMinutes: 15,
      schedules: [
        { scheduleId: ME, availabilityView: '000000000000' },
        { scheduleId: 'sarah@company.com', availabilityView: '000022000000' },
      ],
      workingHours: { daysOfWeek: ['tuesday'], startTime: '09:00', endTime: '12:00' }, limit: 5,
    });
    assert.deepEqual(slots.map((slot) => slot.start), [
      '2026-09-01T09:00:00', '2026-09-01T09:30:00', '2026-09-01T10:30:00', '2026-09-01T11:00:00', '2026-09-01T11:30:00',
    ]);
  });

  test('missing availability is treated as busy, never guessed free', () => {
    const slots = recommendAvailableSlots({
      start: '2026-09-01T09:00:00', end: '2026-09-01T10:00:00', timezone: 'Asia/Taipei',
      durationMinutes: 30, intervalMinutes: 15, schedules: [{ scheduleId: ME, availabilityView: '' }], limit: 5,
    });
    assert.deepEqual(slots, []);
  });

  test('calendar creation preview names a verified conflict without moving the request', async () => {
    const tool = availableTools().find((candidate) => candidate.name === 'calendar_create');
    assert.ok(tool?.preview);
    const args = tool.schema.parse({
      subject: 'Supplier call', start: '2026-09-01T10:30:00', end: '2026-09-01T11:30:00',
      timezone: 'Asia/Taipei', attendees: [], location: '', body: '', isAllDay: false,
    });
    const ctx = {
      user: { id: 'user', msUserId: 'ms', email: ME, displayName: 'Director', jobTitle: null, timezone: 'Asia/Taipei' },
      calendar: { list: async () => [event()] }, refs: new RefTable(), me: ME,
    } as unknown as ToolContext;
    const prepare = tool!.preview as unknown as (value: typeof args, context: ToolContext) => Promise<ActionPreview>;
    const preview = await prepare(args, ctx);
    assert.ok(preview.details.some((detail) => detail.label === 'Conflict check' && /1 conflict/.test(detail.value)));
    assert.match(preview.warning ?? '', /requested time has not been changed/i);
    assert.equal(preview.details.find((detail) => detail.label === 'When')?.value.includes('10:30'), true);
    assert.equal(tool.schema.safeParse({
      subject: 'Invalid', start: '2026-09-01T11:30:00', end: '2026-09-01T10:30:00',
      timezone: 'Asia/Taipei', attendees: [], location: '', body: '', isAllDay: false,
    }).success, false);
  });

  test('thread-aware mail read returns analysis and bounded chronology', async () => {
    const tool = availableTools().find((candidate) => candidate.name === 'mail_read');
    assert.ok(tool);
    const refs = new RefTable();
    const ref = refs.ref('latest');
    const latest: MailMessageDetail = { ...mail({ id: 'latest' }), body: 'Please approve the renewal by Friday.', bodyType: 'text' };
    const ctx = {
      user: { id: 'user', msUserId: 'ms', email: ME, displayName: 'Director', jobTitle: null, timezone: 'Asia/Taipei' },
      me: ME, refs,
      mail: { get: async () => latest, thread: async () => [latest] },
    } as unknown as ToolContext;
    const result = await (tool.execute as (value: { id: string }, context: ToolContext) => Promise<Record<string, unknown>>)({ id: ref }, ctx);
    assert.equal((result.threadContext as { replyState: string }).replyState, 'director_owes_reply');
    assert.equal(((result.executiveAnalysis as { statedDeadline: { statedText: string } }).statedDeadline).statedText, 'by Friday');
  });
});
