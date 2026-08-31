import { z } from 'zod';
import { defineTool, objectSchema, type Tool, type ToolContext } from './types.js';
import { toIana, toWindows } from '../../lib/timezone.js';
import { findCalendarConflicts, recommendAvailableSlots } from '../../calendar/intelligence.js';

const email = z.string().email().max(320).refine((address) => {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  return !['example.com', 'example.org', 'example.net', 'invalid', 'test'].includes(domain) && !domain.endsWith('.invalid');
}, 'Placeholder and reserved email domains cannot be used for real actions.');
const emails = z.array(email).min(1).max(50);
const optEmails = z.array(email).max(50).default([]);
const ref = z.string().regex(/^e\d+$/, 'Use a reference returned by a read tool.');
const iso = z.string().min(10).max(40);

function parseLocalDateTime(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] ?? 0),
  ));
}

function isValidCalendarRange(start: string, end: string): boolean {
  const from = parseLocalDateTime(start)?.getTime() ?? Date.parse(start);
  const to = parseLocalDateTime(end)?.getTime() ?? Date.parse(end);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}

function calendarDate(value: string, timezone: string): { date: string; time: string } {
  const local = parseLocalDateTime(value);
  const date = local ?? new Date(value);
  const timeZone = local ? 'UTC' : toIana(timezone);
  if (Number.isNaN(date.getTime())) return { date: value, time: value };
  return {
    date: new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone })
      .format(date)
      .replace(/^(\w+)\s/, '$1, '),
    time: new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(date).toLowerCase(),
  };
}

export function formatCalendarRange(start: string, end: string, timezone: string): string {
  const from = calendarDate(start, timezone);
  const to = calendarDate(end, timezone);
  return from.date === to.date
    ? `${from.date} · ${from.time}–${to.time}`
    : `${from.date}, ${from.time} to ${to.date}, ${to.time}`;
}

function resolve(value: string, ctx: ToolContext): string {
  const id = ctx.refs.resolve(value);
  if (!id) throw new Error('That item reference is no longer available. Look it up again first.');
  return id;
}

const profileRead = defineTool({
  name: 'profile_read', description: 'Read the signed-in Director profile from Microsoft 365.', riskLevel: 0, capability: 'identity',
  schema: z.object({}), parameters: objectSchema({}), summarise: () => 'Checked the Microsoft 365 profile',
  async execute(_a, ctx) { return ctx.users.getProfile(); },
});

const mailFolders = defineTool({
  name: 'mail_list_folders', description: 'List Outlook mail folders and their unread and total counts.', riskLevel: 0, capability: 'mail_read',
  schema: z.object({}), parameters: objectSchema({}), summarise: () => 'Listed mail folders',
  async execute(_a, ctx) { const folders = await ctx.mail.listFolders(); return { folders: folders.map((folder) => ({ ref: ctx.refs.ref(folder.id), name: folder.name, unread: folder.unread, total: folder.total })) }; },
});

const mailDraft = defineTool({
  name: 'mail_create_draft', description: 'Save a new email as an Outlook draft. Always preview and confirm first.', riskLevel: 1, capability: 'mail_write',
  schema: z.object({ to: emails, cc: optEmails, bcc: optEmails, subject: z.string().min(1).max(300), body: z.string().min(1).max(20_000) }),
  parameters: objectSchema({ to: { type: 'array', items: { type: 'string', format: 'email' } }, cc: { type: 'array', items: { type: 'string', format: 'email' }, default: [] }, bcc: { type: 'array', items: { type: 'string', format: 'email' }, default: [] }, subject: { type: 'string' }, body: { type: 'string' } }, ['to', 'subject', 'body']),
  summarise: (a) => `Created draft: ${a.subject}`,
  preview: (a) => ({ title: 'Save this email as a draft?', summary: a.subject, details: [{ label: 'To', value: a.to.join(', ') }, ...(a.cc.length ? [{ label: 'Cc', value: a.cc.join(', ') }] : []), ...(a.bcc.length ? [{ label: 'Bcc', value: a.bcc.join(', ') }] : []), { label: 'Subject', value: a.subject }, { label: 'Message', value: a.body }] }),
  async execute(a, ctx) { const d = await ctx.mail.createDraft(a); return { saved: true, draftRef: ctx.refs.ref(d.id), subject: d.subject }; },
});

const mailReplyDraft = defineTool({
  name: 'mail_create_reply_draft', description: 'Create an Outlook reply draft to an email reference returned by search/read.', riskLevel: 1, capability: 'mail_write',
  schema: z.object({ messageRef: ref, message: z.string().min(1).max(20_000) }),
  parameters: objectSchema({ messageRef: { type: 'string', description: 'Reference from mail search/read.' }, message: { type: 'string' } }, ['messageRef', 'message']),
  summarise: () => 'Created a reply draft',
  preview: async (a, ctx) => { const m = await ctx.mail.get(resolve(a.messageRef, ctx)); return { title: 'Save this reply as a draft?', summary: m.subject, details: [{ label: 'Reply to', value: m.from?.address ?? 'Original sender' }, { label: 'Message', value: a.message }], warning: 'This saves a draft in Outlook but does not send it.' }; },
  async execute(a, ctx) { const d = await ctx.mail.createReplyDraft(resolve(a.messageRef, ctx), a.message); return { saved: true, draftRef: ctx.refs.ref(d.id), subject: d.subject }; },
});

const mailSend = defineTool({
  name: 'mail_send', description: 'Send a new email. Requires a complete preview and explicit Yes.', riskLevel: 2, capability: 'mail_send',
  schema: z.object({ to: emails, cc: optEmails, bcc: optEmails, subject: z.string().min(1).max(300), body: z.string().min(1).max(20_000) }),
  parameters: objectSchema({ to: { type: 'array', items: { type: 'string', format: 'email' } }, cc: { type: 'array', items: { type: 'string', format: 'email' }, default: [] }, bcc: { type: 'array', items: { type: 'string', format: 'email' }, default: [] }, subject: { type: 'string' }, body: { type: 'string' } }, ['to', 'subject', 'body']),
  summarise: (a) => `Sent email: ${a.subject}`,
  preview: (a) => ({ title: 'Send this email?', summary: a.subject, details: [{ label: 'To', value: a.to.join(', ') }, ...(a.cc.length ? [{ label: 'Cc', value: a.cc.join(', ') }] : []), ...(a.bcc.length ? [{ label: 'Bcc', value: a.bcc.join(', ') }] : []), { label: 'Subject', value: a.subject }, { label: 'Message', value: a.body }], warning: 'This sends immediately from your Outlook account.' }),
  async execute(a, ctx) { await ctx.mail.send(a); return { sent: true, to: a.to, subject: a.subject }; },
});

const mailReply = defineTool({
  name: 'mail_reply', description: 'Send a reply to a referenced email. Search/read first to obtain the reference.', riskLevel: 2, capability: 'mail_send',
  schema: z.object({ messageRef: ref, message: z.string().min(1).max(20_000), replyAll: z.boolean().default(false) }),
  parameters: objectSchema({ messageRef: { type: 'string' }, message: { type: 'string' }, replyAll: { type: 'boolean', default: false } }, ['messageRef', 'message']),
  summarise: (a) => a.replyAll ? 'Sent a reply to everyone' : 'Sent a reply',
  preview: async (a, ctx) => { const m = await ctx.mail.get(resolve(a.messageRef, ctx)); return { title: a.replyAll ? 'Reply to everyone?' : 'Send this reply?', summary: m.subject, details: [{ label: 'Reply to', value: a.replyAll ? 'All original participants' : (m.from?.address ?? 'Original sender') }, { label: 'Message', value: a.message }], warning: a.replyAll ? 'Every original participant may receive this reply.' : 'This sends immediately from your Outlook account.' }; },
  async execute(a, ctx) { await ctx.mail.reply(resolve(a.messageRef, ctx), a.message, a.replyAll); return { sent: true, replyAll: a.replyAll }; },
});

const mailForward = defineTool({
  name: 'mail_forward', description: 'Forward a referenced email, including its existing attachments, to specified recipients.', riskLevel: 2, capability: 'mail_send',
  schema: z.object({ messageRef: ref, to: emails, comment: z.string().max(20_000).default('') }),
  parameters: objectSchema({ messageRef: { type: 'string' }, to: { type: 'array', items: { type: 'string', format: 'email' } }, comment: { type: 'string' } }, ['messageRef', 'to']),
  summarise: () => 'Forwarded an email',
  preview: async (a, ctx) => { const m = await ctx.mail.get(resolve(a.messageRef, ctx)); return { title: 'Forward this email?', summary: m.subject, details: [{ label: 'To', value: a.to.join(', ') }, { label: 'Original sender', value: m.from?.address ?? 'Unknown' }, ...(a.comment ? [{ label: 'Message', value: a.comment }] : [])], warning: 'This sends immediately and includes the original email and its attachments.' }; },
  async execute(a, ctx) { await ctx.mail.forward(resolve(a.messageRef, ctx), a.to, a.comment); return { sent: true, forwarded: true, to: a.to }; },
});

const mailSendDraft = defineTool({
  name: 'mail_send_draft', description: 'Send an existing referenced Outlook draft. Search the mailbox first to obtain its reference.', riskLevel: 2, capability: 'mail_send',
  schema: z.object({ messageRef: ref }),
  parameters: objectSchema({ messageRef: { type: 'string' } }, ['messageRef']),
  summarise: () => 'Sent an Outlook draft',
  preview: async (a, ctx) => { const m = await ctx.mail.get(resolve(a.messageRef, ctx)); return { title: 'Send this Outlook draft?', summary: m.subject, details: [{ label: 'To', value: m.toRecipients.map((r) => r.address).join(', ') || 'No recipient' }, ...(m.ccRecipients.length ? [{ label: 'Cc', value: m.ccRecipients.map((r) => r.address).join(', ') }] : []), ...(m.bccRecipients.length ? [{ label: 'Bcc', value: m.bccRecipients.map((r) => r.address).join(', ') }] : []), { label: 'Subject', value: m.subject }], warning: 'This sends the existing draft immediately.' }; },
  async execute(a, ctx) { await ctx.mail.sendDraft(resolve(a.messageRef, ctx)); return { sent: true }; },
});

const mailState = defineTool({
  name: 'mail_change_state', description: 'Mark a referenced email read/unread or flagged/unflagged.', riskLevel: 1, capability: 'mail_write',
  schema: z.object({ messageRef: ref, change: z.enum(['mark_read', 'mark_unread', 'flag', 'unflag']) }),
  parameters: objectSchema({ messageRef: { type: 'string' }, change: { type: 'string', enum: ['mark_read', 'mark_unread', 'flag', 'unflag'] } }, ['messageRef', 'change']),
  summarise: (a) => `Changed email: ${a.change.replace('_', ' ')}`,
  preview: async (a, ctx) => { const m = await ctx.mail.get(resolve(a.messageRef, ctx)); return { title: 'Change this email?', summary: m.subject, details: [{ label: 'From', value: m.from?.address ?? 'Unknown' }, { label: 'Change', value: a.change.replace('_', ' ') }] }; },
  async execute(a, ctx) { const id = resolve(a.messageRef, ctx); if (a.change.startsWith('mark_')) await ctx.mail.setRead(id, a.change === 'mark_read'); else await ctx.mail.setFlag(id, a.change === 'flag'); return { changed: true, change: a.change }; },
});

const mailMove = defineTool({
  name: 'mail_move', description: 'Move a referenced email to archive, deleted items, inbox, or a folder id.', riskLevel: 1, capability: 'mail_write',
  schema: z.object({ messageRef: ref, destination: z.enum(['archive', 'deleteditems', 'inbox']).optional(), folderRef: ref.optional() }).refine((a) => Boolean(a.destination || a.folderRef), 'Choose a standard destination or folder reference.'),
  parameters: objectSchema({ messageRef: { type: 'string' }, destination: { type: 'string', enum: ['archive', 'deleteditems', 'inbox'] }, folderRef: { type: 'string', description: 'Opaque reference from mail_list_folders for a custom folder.' } }, ['messageRef']),
  summarise: () => 'Moved an email',
  preview: async (a, ctx) => { const m = await ctx.mail.get(resolve(a.messageRef, ctx)); const destination = a.destination ?? (await ctx.mail.getFolder(resolve(a.folderRef!, ctx))).name; return { title: 'Move this email?', summary: m.subject, details: [{ label: 'From', value: m.from?.address ?? 'Unknown' }, { label: 'Destination', value: destination }] }; },
  async execute(a, ctx) { const destination = a.destination ?? resolve(a.folderRef!, ctx); await ctx.mail.move(resolve(a.messageRef, ctx), destination); return { moved: true }; },
});

const mailDelete = defineTool({
  name: 'mail_delete', description: 'Permanently delete a referenced email. Use move to deleteditems when recoverability is desired.', riskLevel: 3, capability: 'mail_write',
  schema: z.object({ messageRef: ref }), parameters: objectSchema({ messageRef: { type: 'string' } }, ['messageRef']), summarise: () => 'Deleted an email',
  preview: async (a, ctx) => { const m = await ctx.mail.get(resolve(a.messageRef, ctx)); return { title: 'Permanently delete this email?', summary: m.subject, details: [{ label: 'From', value: m.from?.address ?? 'Unknown' }], warning: 'This is destructive. Prefer moving it to Deleted Items if it may be needed later.' }; },
  async execute(a, ctx) { await ctx.mail.delete(resolve(a.messageRef, ctx)); return { deleted: true }; },
});

const mailboxGet = defineTool({
  name: 'mailbox_settings_read', description: 'Read Outlook timezone, working hours, and automatic reply settings.', riskLevel: 0, capability: 'mailbox_settings',
  schema: z.object({}), parameters: objectSchema({}), summarise: () => 'Checked mailbox settings', async execute(_a, ctx) { return ctx.users.getMailboxSettings(); },
});

const mailboxUpdate = defineTool({
  name: 'mailbox_settings_update', description: 'Update Outlook timezone, working hours, or automatic replies. Supply only fields to change.', riskLevel: 2, capability: 'mailbox_settings',
  schema: z.object({ timezone: z.string().max(100).optional(), workingHours: z.object({ daysOfWeek: z.array(z.string()).min(1), startTime: z.string(), endTime: z.string(), timezone: z.string() }).optional(), automaticReplies: z.object({ status: z.enum(['disabled', 'alwaysEnabled', 'scheduled']), externalAudience: z.enum(['none', 'contactsOnly', 'all']).default('none'), internalMessage: z.string().max(10_000).default(''), externalMessage: z.string().max(10_000).default(''), start: iso.optional(), end: iso.optional(), timezone: z.string().default('UTC') }).optional() }).refine((v) => v.timezone || v.workingHours || v.automaticReplies, 'Supply at least one setting.'),
  parameters: objectSchema({ timezone: { type: 'string' }, workingHours: { type: 'object' }, automaticReplies: { type: 'object' } }),
  summarise: () => 'Updated mailbox settings',
  preview: (a) => ({ title: 'Update Outlook settings?', summary: 'These settings affect your mailbox and availability.', details: [...(a.timezone ? [{ label: 'Timezone', value: a.timezone }] : []), ...(a.workingHours ? [{ label: 'Working hours', value: `${a.workingHours.daysOfWeek.join(', ')} · ${a.workingHours.startTime}–${a.workingHours.endTime} (${a.workingHours.timezone})` }] : []), ...(a.automaticReplies ? [{ label: 'Automatic replies', value: a.automaticReplies.status }, { label: 'Internal message', value: a.automaticReplies.internalMessage }, { label: 'External message', value: a.automaticReplies.externalMessage }] : [])] }),
  async execute(a, ctx) { const body: Record<string, unknown> = {}; if (a.timezone) body.timeZone = toWindows(a.timezone); if (a.workingHours) body.workingHours = { daysOfWeek: a.workingHours.daysOfWeek, startTime: a.workingHours.startTime, endTime: a.workingHours.endTime, timeZone: { name: toWindows(a.workingHours.timezone) } }; if (a.automaticReplies) body.automaticRepliesSetting = { status: a.automaticReplies.status, externalAudience: a.automaticReplies.externalAudience, internalReplyMessage: a.automaticReplies.internalMessage, externalReplyMessage: a.automaticReplies.externalMessage, scheduledStartDateTime: a.automaticReplies.start ? { dateTime: a.automaticReplies.start, timeZone: toWindows(a.automaticReplies.timezone) } : undefined, scheduledEndDateTime: a.automaticReplies.end ? { dateTime: a.automaticReplies.end, timeZone: toWindows(a.automaticReplies.timezone) } : undefined }; await ctx.users.updateMailboxSettings(body); return { updated: true }; },
});

const calendarList = defineTool({
  name: 'calendar_list', description: 'List calendar events in an explicit date range and report verified overlaps. Use this when the date is known. Use calendar_search when only the event title is known or the Director asks to search the whole calendar. Use the Director timezone. This reads data and never changes the calendar.', riskLevel: 0, capability: 'calendar_read',
  schema: z.object({ start: iso, end: iso, timezone: z.string().min(1).max(100), limit: z.number().int().min(1).max(100).default(50) }),
  parameters: objectSchema({ start: { type: 'string', description: 'Inclusive range start as an ISO date-time.' }, end: { type: 'string', description: 'Exclusive range end as an ISO date-time.' }, timezone: { type: 'string', description: 'Director timezone.' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Maximum events to return. Never exceed 100.' } }, ['start', 'end', 'timezone']),
  summarise: () => 'Checked the calendar', async execute(a, ctx) {
    const events = await ctx.calendar.list(a.start, a.end, a.timezone, a.limit);
    const seen = new Set<string>();
    const overlaps = events.flatMap((event) => findCalendarConflicts({ start: event.start, end: event.end, timezone: a.timezone }, events, event.id)
      .flatMap((conflict) => {
        const key = [event.id, conflict.id].sort().join(':');
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ first: event.subject, second: conflict.subject, start: conflict.start, end: conflict.end }];
      }));
    return {
      count: events.length,
      conflictStatus: overlaps.length ? 'conflicts_found' : 'no_conflicts_found',
      overlaps,
      events: events.map((e) => ({ ...e, ref: ctx.refs.ref(e.id), id: undefined })),
    };
  },
});

const calendarSearch = defineTool({
  name: 'calendar_search',
  description: 'Search the Director\'s default calendar by event subject when the date is unknown or the Director asks to search the whole calendar. This is read-only. It returns single events and recurring-series masters; when a particular recurring occurrence or date is meant, verify it with calendar_list before changing it.',
  riskLevel: 0,
  capability: 'calendar_read',
  schema: z.object({
    query: z.string().trim().min(1).max(200),
    timezone: z.string().min(1).max(100),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  parameters: objectSchema({
    query: { type: 'string', minLength: 1, maxLength: 200, description: 'Distinctive words from the event subject, not an OData expression.' },
    timezone: { type: 'string', description: 'Director timezone.' },
    limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
  }, ['query', 'timezone']),
  summarise: () => 'Searched the calendar by title',
  async execute(a, ctx) {
    const events = await ctx.calendar.search(a.query, a.timezone, a.limit);
    return {
      count: events.length,
      query: a.query,
      events: events.map((event) => ({ ...event, ref: ctx.refs.ref(event.id), id: undefined })),
      note: events.length
        ? 'These are verified Microsoft 365 calendar matches. No event has been changed.'
        : 'No matching event subject was found. No event has been changed.',
    };
  },
});

const calendarFindSlots = defineTool({
  name: 'calendar_find_slots',
  description: 'Find verified free slots within an explicit range using Microsoft 365 free/busy for the Director and exact attendee email addresses. Use after resolving named employees in the directory. It reads availability only, does not create a meeting, and does not infer a precise time when none is free.',
  riskLevel: 0,
  capability: 'calendar_read',
  schema: z.object({
    start: iso,
    end: iso,
    timezone: z.string().min(1).max(100),
    durationMinutes: z.number().int().min(15).max(240).default(30),
    attendees: z.array(email).max(19).default([]),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  parameters: objectSchema({
    start: { type: 'string', description: 'Start of the search range as an ISO local date-time.' },
    end: { type: 'string', description: 'End of the search range as an ISO local date-time, no more than 14 days later.' },
    timezone: { type: 'string', description: 'Director timezone.' },
    durationMinutes: { type: 'integer', description: 'Required meeting duration, 15 to 240 minutes.', default: 30 },
    attendees: { type: 'array', items: { type: 'string', format: 'email' }, description: 'Exact, already-resolved attendee addresses.', default: [] },
    limit: { type: 'integer', default: 5 },
  }, ['start', 'end', 'timezone']),
  summarise: () => 'Checked verified free time',
  async execute(a, ctx) {
    const from = Date.parse(a.start);
    const to = Date.parse(a.end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 14 * 86_400_000) {
      throw new Error('Choose a valid availability range of no more than 14 days.');
    }
    const settings = await ctx.users.getMailboxSettings();
    const schedules = [...new Set([ctx.me.toLowerCase(), ...a.attendees.map((address) => address.toLowerCase())])];
    const availability = await ctx.calendar.getSchedule(schedules, a.start, a.end, a.timezone, 15);
    const slots = recommendAvailableSlots({
      start: a.start,
      end: a.end,
      timezone: a.timezone,
      durationMinutes: a.durationMinutes,
      intervalMinutes: 15,
      schedules: availability,
      workingHours: settings.workingHours,
      limit: a.limit,
    });
    return {
      schedulesChecked: availability.map((schedule) => schedule.scheduleId),
      attendeeAvailabilityVerified: true,
      workingHours: settings.workingHours,
      slots,
      note: slots.length
        ? 'These times are free in the returned Microsoft 365 schedules. No meeting has been created and no invitation has been sent.'
        : 'No qualifying free slot was found in the requested range. Do not invent or silently move to another time.',
    };
  },
});

const calendarCreate = defineTool({
  name: 'calendar_create', description: 'Create a calendar event or meeting, optionally with an Outlook reminder. Explicit Yes is required; attendees receive invitations.', riskLevel: 2, capability: 'calendar_write',
  schema: z.object({ subject: z.string().min(1).max(300), start: iso, end: iso, timezone: z.string().min(1), location: z.string().max(500).default(''), attendees: z.array(email).max(100).default([]), body: z.string().max(10_000).default(''), isAllDay: z.boolean().default(false), reminderMinutesBeforeStart: z.number().int().min(0).max(40_320).optional() })
    .refine((value) => isValidCalendarRange(value.start, value.end), { message: 'The calendar end time must be after the start time.', path: ['end'] }),
  parameters: objectSchema({ subject: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, timezone: { type: 'string' }, location: { type: 'string' }, attendees: { type: 'array', items: { type: 'string', format: 'email' } }, body: { type: 'string' }, isAllDay: { type: 'boolean' }, reminderMinutesBeforeStart: { type: 'integer', minimum: 0, maximum: 40320, description: 'Exact number of minutes before the start for an Outlook reminder. Omit unless the Director supplied it.' } }, ['subject', 'start', 'end', 'timezone']),
  summarise: (a) => `Created calendar event: ${a.subject}`,
  preview: async (a, ctx) => {
    const events = await ctx.calendar.list(a.start, a.end, a.timezone, 20);
    const conflicts = findCalendarConflicts(a, events);
    const warnings = [
      ...(conflicts.length ? [`This time conflicts with ${conflicts.map((event) => event.subject).join(', ')}. The requested time has not been changed.`] : []),
      ...(a.attendees.length ? ['Creating this event sends invitations to the attendees.'] : []),
    ];
    return {
      title: 'Add this to the calendar?',
      summary: a.subject,
      details: [
        { label: 'When', value: formatCalendarRange(a.start, a.end, a.timezone) },
        { label: 'Conflict check', value: conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} found` : 'No conflict found' },
        ...conflicts.slice(0, 3).map((event) => ({ label: 'Conflicts with', value: `${event.subject}: ${formatCalendarRange(event.start, event.end, a.timezone)}` })),
        ...(toIana(a.timezone) !== toIana(ctx.user.timezone) ? [{ label: 'Timezone', value: a.timezone }] : []),
        ...(a.location ? [{ label: 'Where', value: a.location }] : []),
        ...(a.attendees.length ? [{ label: 'Attendees', value: a.attendees.join(', ') }] : []),
        ...(a.body ? [{ label: 'Notes', value: a.body }] : []),
        ...(a.reminderMinutesBeforeStart !== undefined ? [{ label: 'Reminder', value: a.reminderMinutesBeforeStart === 0 ? 'At the start time' : `${a.reminderMinutesBeforeStart} minutes before` }] : []),
      ],
      warning: warnings.length ? warnings.join(' ') : undefined,
    };
  },
  async execute(a, ctx) { const e = await ctx.calendar.create(a); return { created: true, eventRef: ctx.refs.ref(e.id), subject: e.subject, start: e.start, end: e.end }; },
});

const calendarUpdate = defineTool({
  name: 'calendar_update', description: 'Update a referenced calendar event. List calendar first. Attendees may receive an update.', riskLevel: 2, capability: 'calendar_write',
  schema: z.object({
    eventRef: ref,
    subject: z.string().max(300).optional(),
    start: iso.optional(),
    end: iso.optional(),
    timezone: z.string().optional(),
    location: z.string().max(500).optional(),
    body: z.string().max(10_000).optional(),
    addAttendees: z.array(email).max(100).default([]),
    removeAttendees: z.array(email).max(100).default([]),
  }).superRefine((a, issue) => {
    if (!Boolean(a.subject || a.start || a.end || a.location !== undefined || a.body !== undefined || a.addAttendees.length || a.removeAttendees.length)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'Supply at least one calendar change.' });
    }
    const additions = new Set(a.addAttendees.map((address) => address.toLowerCase()));
    const conflict = a.removeAttendees.find((address) => additions.has(address.toLowerCase()));
    if (conflict) issue.addIssue({ code: z.ZodIssueCode.custom, path: ['removeAttendees'], message: `${conflict} cannot be added and removed in the same update.` });
  }),
  parameters: objectSchema({
    eventRef: { type: 'string' }, subject: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
    timezone: { type: 'string' }, location: { type: 'string' }, body: { type: 'string' },
    addAttendees: { type: 'array', items: { type: 'string', format: 'email' }, description: 'People to add without removing current attendees.' },
    removeAttendees: { type: 'array', items: { type: 'string', format: 'email' }, description: 'Current attendees to remove.' },
  }, ['eventRef']),
  summarise: () => 'Updated a calendar event',
  preview: async (a, ctx) => {
    const current = await ctx.calendar.get(resolve(a.eventRef, ctx));
    const changeTimezone = a.timezone ?? current.timezone;
    const proposed = { start: a.start ?? current.start, end: a.end ?? current.end, timezone: changeTimezone };
    if (!isValidCalendarRange(proposed.start, proposed.end)) throw new Error('The calendar end time must be after the start time.');
    const conflicts = a.start || a.end
      ? findCalendarConflicts(proposed, await ctx.calendar.list(proposed.start, proposed.end, changeTimezone, 20), current.id)
      : [];
    const attendeeWarning = a.addAttendees.length || a.removeAttendees.length ? 'Attendee changes send a meeting update.' : 'Meeting attendees may receive an update.';
    return ({
    title: 'Update this calendar event?',
    summary: current.subject,
    details: [
      { label: 'Current time', value: formatCalendarRange(current.start, current.end, current.timezone) },
      ...(a.subject ? [{ label: 'New title', value: a.subject }] : []),
      ...(a.start || a.end ? [{ label: 'New time', value: formatCalendarRange(a.start ?? current.start, a.end ?? current.end, changeTimezone) }] : []),
      ...(a.start || a.end ? [{ label: 'Conflict check', value: conflicts.length ? `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} found` : 'No conflict found' }] : []),
      ...conflicts.slice(0, 3).map((event) => ({ label: 'Conflicts with', value: `${event.subject}: ${formatCalendarRange(event.start, event.end, changeTimezone)}` })),
      ...(a.location !== undefined ? [{ label: 'New location', value: a.location || 'Remove location' }] : []),
      ...(a.body !== undefined ? [{ label: 'New notes', value: a.body || 'Remove notes' }] : []),
      ...(a.addAttendees.length ? [{ label: 'Add attendees', value: a.addAttendees.join(', ') }] : []),
      ...(a.removeAttendees.length ? [{ label: 'Remove attendees', value: a.removeAttendees.join(', ') }] : []),
    ],
    warning: `${conflicts.length ? `The new time conflicts with ${conflicts.map((event) => event.subject).join(', ')}. The requested time has not been changed. ` : ''}${attendeeWarning}`,
  }); },
  async execute(a, ctx) {
    const eventId = resolve(a.eventRef, ctx);
    const current = await ctx.calendar.get(eventId);
    const changeTimezone = a.timezone ?? current.timezone;
    const changes: Record<string, unknown> = {};
    if (a.subject) changes.subject = a.subject;
    if (a.location !== undefined) changes.location = { displayName: a.location };
    if (a.body !== undefined) changes.body = { contentType: 'Text', content: a.body };
    if (a.start) changes.start = { dateTime: a.start, timeZone: toWindows(changeTimezone) };
    if (a.end) changes.end = { dateTime: a.end, timeZone: toWindows(changeTimezone) };
    if (a.addAttendees.length || a.removeAttendees.length) {
      const remove = new Set(a.removeAttendees.map((address) => address.toLowerCase()));
      const merged = new Map(current.attendees
        .filter((attendee) => attendee.address && !remove.has(attendee.address.toLowerCase()))
        .map((attendee) => [attendee.address.toLowerCase(), attendee.address]));
      for (const address of a.addAttendees) merged.set(address.toLowerCase(), address);
      changes.attendees = [...merged.values()].map((address) => ({ emailAddress: { address }, type: 'required' }));
    }
    await ctx.calendar.update(eventId, changes);
    return { updated: true, addedAttendees: a.addAttendees, removedAttendees: a.removeAttendees };
  },
});

const calendarDelete = defineTool({
  name: 'calendar_delete', description: 'Delete or cancel one exact referenced calendar event. Find it with calendar_list or calendar_search first. This always creates a destructive-action approval and never executes immediately.', riskLevel: 3, capability: 'calendar_write',
  schema: z.object({ eventRef: ref, title: z.string().max(300).default('Selected event') }), parameters: objectSchema({ eventRef: { type: 'string' }, title: { type: 'string' } }, ['eventRef']), summarise: () => 'Deleted the selected calendar event',
  preview: async (a, ctx) => { const event = await ctx.calendar.get(resolve(a.eventRef, ctx)); return { title: event.type === 'seriesMaster' ? 'Delete this recurring series?' : 'Delete this calendar event?', summary: event.subject, details: [{ label: 'When', value: formatCalendarRange(event.start, event.end, event.timezone) }, ...(event.type === 'seriesMaster' ? [{ label: 'Scope', value: 'Entire recurring series' }] : []), ...(event.location ? [{ label: 'Where', value: event.location }] : []), ...(event.attendees.length ? [{ label: 'Attendees', value: event.attendees.map((attendee) => attendee.name || attendee.address).join(', ') }] : [])], warning: `${event.type === 'seriesMaster' ? 'This removes every occurrence in the recurring series. ' : 'This removes the event. '}${event.attendees.length ? 'If you organised the meeting, Outlook sends cancellation notices to attendees.' : 'This cannot be undone in Hermes.'}` }; },
  async execute(a, ctx) { await ctx.calendar.delete(resolve(a.eventRef, ctx)); return { deleted: true }; },
});

const calendarRespond = defineTool({
  name: 'calendar_respond', description: 'Accept, tentatively accept, or decline a referenced meeting invitation.', riskLevel: 2, capability: 'calendar_write',
  schema: z.object({ eventRef: ref, response: z.enum(['accept', 'tentativelyAccept', 'decline']), comment: z.string().max(5000).default(''), sendResponse: z.boolean().default(true) }),
  parameters: objectSchema({ eventRef: { type: 'string' }, response: { type: 'string', enum: ['accept', 'tentativelyAccept', 'decline'] }, comment: { type: 'string' }, sendResponse: { type: 'boolean', default: true } }, ['eventRef', 'response']),
  summarise: (a) => `${a.response === 'tentativelyAccept' ? 'Tentatively accepted' : a.response === 'accept' ? 'Accepted' : 'Declined'} the meeting invitation`,
  preview: async (a, ctx) => { const event = await ctx.calendar.get(resolve(a.eventRef, ctx)); return { title: `${a.response === 'tentativelyAccept' ? 'Tentatively accept' : a.response === 'accept' ? 'Accept' : 'Decline'} this meeting?`, summary: event.subject, details: [{ label: 'When', value: formatCalendarRange(event.start, event.end, event.timezone) }, { label: 'Organiser', value: event.organiser || 'Unknown' }, ...(a.comment ? [{ label: 'Message', value: a.comment }] : [])], warning: a.sendResponse ? 'Your response will be sent to the organiser.' : 'Your calendar will be updated without sending a response.' }; },
  async execute(a, ctx) { await ctx.calendar.respond(resolve(a.eventRef, ctx), a.response, a.comment, a.sendResponse); return { responded: true, response: a.response }; },
});

const contactsSearch = defineTool({
  name: 'contacts_search', description: 'Search Outlook personal contacts.', riskLevel: 0, capability: 'contacts_read',
  schema: z.object({ query: z.string().max(200).default(''), limit: z.number().int().min(1).max(50).default(20) }), parameters: objectSchema({ query: { type: 'string' }, limit: { type: 'integer', default: 20 } }), summarise: () => 'Searched contacts',
  async execute(a, ctx) { const contacts = await ctx.contacts.list(a.query, a.limit); return { contacts: contacts.map((c) => ({ ...c, ref: ctx.refs.ref(c.id), id: undefined })) }; },
});
const peopleSearch = defineTool({
  name: 'people_search', description: 'Find people relevant to the Director from Microsoft 365.', riskLevel: 0, capability: 'contacts_read',
  schema: z.object({ query: z.string().max(200).default(''), limit: z.number().int().min(1).max(25).default(10) }), parameters: objectSchema({ query: { type: 'string' }, limit: { type: 'integer' } }), summarise: () => 'Looked up relevant people', async execute(a, ctx) { return { people: await ctx.contacts.people(a.query, a.limit) }; },
});
const directorySearch = defineTool({
  name: 'directory_search', description: 'Resolve a person from the Director\'s organisation directory. Results are restricted to the organisation email domain; use this for meeting attendees.', riskLevel: 0, capability: 'contacts_read',
  schema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(25).default(10) }), parameters: objectSchema({ query: { type: 'string', description: 'The person\'s name or organisation email address.' }, limit: { type: 'integer' } }, ['query']), summarise: () => 'Searched the organisation directory', async execute(a, ctx) {
    const organisationDomain = ctx.me.split('@')[1]?.toLowerCase() ?? '';
    const people = organisationDomain
      ? await ctx.users.searchOrganisationDirectory(a.query, organisationDomain, a.limit)
      : [];
    return {
      organisationDomain,
      people,
      resolution: people.length === 1 ? 'unique' : people.length > 1 ? 'ambiguous' : 'not_found',
      instruction: people.length === 1
        ? 'Use this exact organisation email address.'
        : people.length > 1
          ? 'Ask the Director which person they mean. Do not choose one.'
          : 'No organisation account matched. Do not use a relevant-people or example address.',
    };
  },
});

const contactCreate = defineTool({
  name: 'contact_create', description: 'Create an Outlook contact.', riskLevel: 2, capability: 'contacts_read',
  schema: z.object({ name: z.string().min(1).max(200), email, company: z.string().max(200).default(''), jobTitle: z.string().max(200).default(''), phone: z.string().max(50).default('') }), parameters: objectSchema({ name: { type: 'string' }, email: { type: 'string', format: 'email' }, company: { type: 'string' }, jobTitle: { type: 'string' }, phone: { type: 'string' } }, ['name', 'email']), summarise: (a) => `Created contact: ${a.name}`,
  preview: (a) => ({ title: 'Add this Outlook contact?', summary: a.name, details: [{ label: 'Email', value: a.email }, ...(a.company ? [{ label: 'Company', value: a.company }] : []), ...(a.jobTitle ? [{ label: 'Role', value: a.jobTitle }] : []), ...(a.phone ? [{ label: 'Phone', value: a.phone }] : [])] }),
  async execute(a, ctx) { const c = await ctx.contacts.create(a); return { created: true, contactRef: ctx.refs.ref(c.id), name: c.name }; },
});
const contactUpdate = defineTool({
  name: 'contact_update', description: 'Update a referenced Outlook contact. Search contacts first.', riskLevel: 2, capability: 'contacts_read',
  schema: z.object({ contactRef: ref, name: z.string().max(200).optional(), email: email.optional(), company: z.string().max(200).optional(), jobTitle: z.string().max(200).optional(), phone: z.string().max(50).optional() }), parameters: objectSchema({ contactRef: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' }, jobTitle: { type: 'string' }, phone: { type: 'string' } }, ['contactRef']), summarise: () => 'Updated an Outlook contact',
  preview: async (a, ctx) => { const contact = await ctx.contacts.get(resolve(a.contactRef, ctx)); return { title: 'Update this Outlook contact?', summary: contact.name || contact.email, details: [{ label: 'Current email', value: contact.email || 'None' }, ...Object.entries(a).filter(([k, v]) => k !== 'contactRef' && v !== undefined).map(([label, value]) => ({ label: `New ${label}`, value: String(value) }))] }; },
  async execute(a, ctx) { const changes: Record<string, unknown> = {}; if (a.name) changes.displayName = a.name; if (a.email) changes.emailAddresses = [{ address: a.email, name: a.name ?? a.email }]; if (a.company !== undefined) changes.companyName = a.company; if (a.jobTitle !== undefined) changes.jobTitle = a.jobTitle; if (a.phone !== undefined) changes.mobilePhone = a.phone; await ctx.contacts.update(resolve(a.contactRef, ctx), changes); return { updated: true }; },
});
const contactDelete = defineTool({
  name: 'contact_delete', description: 'Delete a referenced Outlook contact.', riskLevel: 3, capability: 'contacts_read',
  schema: z.object({ contactRef: ref, name: z.string().max(200).default('Selected contact') }), parameters: objectSchema({ contactRef: { type: 'string' }, name: { type: 'string' } }, ['contactRef']), summarise: () => 'Deleted the selected contact',
  preview: async (a, ctx) => { const contact = await ctx.contacts.get(resolve(a.contactRef, ctx)); return { title: 'Delete this Outlook contact?', summary: contact.name || contact.email || 'Selected contact', details: [{ label: 'Email', value: contact.email || 'None' }], warning: 'This permanently removes the contact.' }; }, async execute(a, ctx) { await ctx.contacts.delete(resolve(a.contactRef, ctx)); return { deleted: true }; },
});

const taskLists = defineTool({
  name: 'task_lists', description: 'List Microsoft To Do task lists.', riskLevel: 0, capability: 'tasks', schema: z.object({}), parameters: objectSchema({}), summarise: () => 'Listed task lists', async execute(_a, ctx) { const lists = await ctx.tasks.lists(); return { lists: lists.map((l) => ({ ...l, ref: ctx.refs.ref(l.id), id: undefined })) }; },
});
const taskList = defineTool({
  name: 'tasks_list', description: 'List tasks from a referenced Microsoft To Do list. Call task_lists first.', riskLevel: 0, capability: 'tasks', schema: z.object({ listRef: ref, limit: z.number().int().min(1).max(100).default(50) }), parameters: objectSchema({ listRef: { type: 'string' }, limit: { type: 'integer' } }, ['listRef']), summarise: () => 'Listed tasks', async execute(a, ctx) { const tasks = await ctx.tasks.list(resolve(a.listRef, ctx), a.limit); return { tasks: tasks.map((t) => ({ ...t, ref: ctx.refs.ref(t.id), id: undefined })) }; },
});
const taskCreate = defineTool({
  name: 'task_create', description: 'Create a Microsoft To Do task in a referenced list.', riskLevel: 1, capability: 'tasks', schema: z.object({ listRef: ref, title: z.string().min(1).max(300), due: iso.optional(), timezone: z.string().default('UTC'), body: z.string().max(10_000).default(''), importance: z.enum(['low', 'normal', 'high']).default('normal') }), parameters: objectSchema({ listRef: { type: 'string' }, title: { type: 'string' }, due: { type: 'string' }, timezone: { type: 'string' }, body: { type: 'string' }, importance: { type: 'string', enum: ['low', 'normal', 'high'] } }, ['listRef', 'title']), summarise: (a) => `Created task: ${a.title}`,
  preview: (a) => ({ title: 'Create this task?', summary: a.title, details: [...(a.due ? [{ label: 'Due', value: `${a.due} (${a.timezone})` }] : []), { label: 'Importance', value: a.importance }, ...(a.body ? [{ label: 'Notes', value: a.body }] : [])] }), async execute(a, ctx) { const result = await ctx.tasks.create(resolve(a.listRef, ctx), a); return { created: true, taskRef: ctx.refs.ref(result.id), title: a.title }; },
});
const taskUpdate = defineTool({
  name: 'task_update', description: 'Update or complete a referenced Microsoft To Do task.', riskLevel: 1, capability: 'tasks', schema: z.object({ listRef: ref, taskRef: ref, title: z.string().max(300).optional(), status: z.enum(['notStarted', 'inProgress', 'completed', 'waitingOnOthers', 'deferred']).optional(), due: iso.optional(), timezone: z.string().default('UTC'), importance: z.enum(['low', 'normal', 'high']).optional() }), parameters: objectSchema({ listRef: { type: 'string' }, taskRef: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, due: { type: 'string' }, timezone: { type: 'string' }, importance: { type: 'string' } }, ['listRef', 'taskRef']), summarise: () => 'Updated a task',
  preview: async (a, ctx) => { const task = await ctx.tasks.get(resolve(a.listRef, ctx), resolve(a.taskRef, ctx)); return { title: 'Update this task?', summary: task.title, details: Object.entries(a).filter(([k, v]) => !k.endsWith('Ref') && k !== 'timezone' && v !== undefined).map(([label, value]) => ({ label: `New ${label}`, value: String(value) })) }; }, async execute(a, ctx) { const changes: Record<string, unknown> = {}; if (a.title) changes.title = a.title; if (a.status) changes.status = a.status; if (a.importance) changes.importance = a.importance; if (a.due) changes.dueDateTime = { dateTime: a.due, timeZone: toWindows(a.timezone) }; await ctx.tasks.update(resolve(a.listRef, ctx), resolve(a.taskRef, ctx), changes); return { updated: true }; },
});
const taskDelete = defineTool({
  name: 'task_delete', description: 'Delete a referenced Microsoft To Do task.', riskLevel: 3, capability: 'tasks', schema: z.object({ listRef: ref, taskRef: ref, title: z.string().max(300).default('Selected task') }), parameters: objectSchema({ listRef: { type: 'string' }, taskRef: { type: 'string' }, title: { type: 'string' } }, ['listRef', 'taskRef']), summarise: () => 'Deleted the selected task',
  preview: async (a, ctx) => { const task = await ctx.tasks.get(resolve(a.listRef, ctx), resolve(a.taskRef, ctx)); return { title: 'Delete this task?', summary: task.title, details: [...(task.due ? [{ label: 'Due', value: task.due }] : [])], warning: 'This permanently removes the task.' }; }, async execute(a, ctx) { await ctx.tasks.delete(resolve(a.listRef, ctx), resolve(a.taskRef, ctx)); return { deleted: true }; },
});

export const officeTools: Tool<never>[] = [
  profileRead, mailFolders, mailDraft, mailReplyDraft, mailSend, mailReply, mailForward, mailSendDraft, mailState, mailMove, mailDelete,
  mailboxGet, mailboxUpdate, calendarList, calendarSearch, calendarFindSlots, calendarCreate, calendarUpdate, calendarDelete, calendarRespond,
  contactsSearch, peopleSearch, directorySearch, contactCreate, contactUpdate, contactDelete,
  taskLists, taskList, taskCreate, taskUpdate, taskDelete,
] as unknown as Tool<never>[];
