import type { GraphClient } from './client.js';
import { toWindows } from '../lib/timezone.js';
import type { ScheduleAvailability } from '../calendar/intelligence.js';

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  timezone: string;
  location: string;
  organiser: string;
  attendees: Array<{ name: string; address: string; response: string }>;
  isAllDay: boolean;
  isCancelled: boolean;
  webLink: string;
}

interface GraphEvent {
  id: string; subject?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string }; organizer?: { emailAddress?: { address?: string } };
  attendees?: Array<{ emailAddress?: { name?: string; address?: string }; status?: { response?: string } }>;
  isAllDay?: boolean; isCancelled?: boolean; webLink?: string;
}

interface GraphScheduleInformation {
  scheduleId?: string;
  availabilityView?: string;
}

const SELECT = 'id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,webLink';

export class CalendarService {
  constructor(private readonly graph: GraphClient) {}

  private shape(e: GraphEvent): CalendarEvent {
    return {
      id: e.id, subject: e.subject?.trim() || '(untitled)', start: e.start?.dateTime ?? '', end: e.end?.dateTime ?? '',
      timezone: e.start?.timeZone ?? 'UTC', location: e.location?.displayName ?? '',
      organiser: e.organizer?.emailAddress?.address ?? '',
      attendees: (e.attendees ?? []).map((a) => ({ name: a.emailAddress?.name ?? a.emailAddress?.address ?? '', address: a.emailAddress?.address ?? '', response: a.status?.response ?? 'none' })),
      isAllDay: e.isAllDay ?? false, isCancelled: e.isCancelled ?? false, webLink: e.webLink ?? '',
    };
  }

  async list(start: string, end: string, timezone: string, limit = 50): Promise<CalendarEvent[]> {
    const graphTimezone = toWindows(timezone);
    const events = await this.graph.collect<GraphEvent>('/me/calendarView', {
      query: { startDateTime: start, endDateTime: end, $select: SELECT, $orderby: 'start/dateTime', $top: Math.min(limit, 100) },
      headers: { Prefer: `outlook.timezone="${graphTimezone.replace(/"/g, '')}"` }, label: 'calendar.list',
    }, Math.ceil(limit / 100));
    return events.slice(0, limit).map((e) => this.shape(e));
  }

  /** Read-only free/busy data for the Director and explicitly resolved attendees. */
  async getSchedule(
    schedules: string[],
    start: string,
    end: string,
    timezone: string,
    intervalMinutes = 15,
  ): Promise<ScheduleAvailability[]> {
    const graphTimezone = toWindows(timezone);
    const response = await this.graph.request<{ value?: GraphScheduleInformation[] }>('/me/calendar/getSchedule', {
      method: 'POST',
      headers: { Prefer: `outlook.timezone="${graphTimezone.replace(/"/g, '')}"` },
      body: {
        schedules,
        startTime: { dateTime: start, timeZone: graphTimezone },
        endTime: { dateTime: end, timeZone: graphTimezone },
        availabilityViewInterval: intervalMinutes,
      },
      label: 'calendar.getSchedule',
      retry: 'safe',
    });
    return (response.value ?? []).map((row) => ({
      scheduleId: row.scheduleId ?? 'unknown',
      availabilityView: row.availabilityView ?? '',
    }));
  }

  async create(input: { subject: string; start: string; end: string; timezone: string; location?: string; attendees?: string[]; body?: string; isAllDay?: boolean }): Promise<CalendarEvent> {
    const graphTimezone = toWindows(input.timezone);
    const e = await this.graph.request<GraphEvent>('/me/events', {
      method: 'POST', body: {
        subject: input.subject, start: { dateTime: input.start, timeZone: graphTimezone }, end: { dateTime: input.end, timeZone: graphTimezone },
        location: input.location ? { displayName: input.location } : undefined,
        attendees: (input.attendees ?? []).map((address) => ({ emailAddress: { address }, type: 'required' })),
        body: input.body ? { contentType: 'Text', content: input.body } : undefined,
        isAllDay: input.isAllDay ?? false,
      }, label: 'calendar.create',
    });
    return this.shape(e);
  }

  async get(id: string): Promise<CalendarEvent> {
    const event = await this.graph.request<GraphEvent>(`/me/events/${id}`, {
      query: { $select: SELECT },
      label: 'calendar.get',
    });
    return this.shape(event);
  }

  async update(id: string, changes: Record<string, unknown>): Promise<void> {
    await this.graph.request(`/me/events/${id}`, { method: 'PATCH', body: changes, label: 'calendar.update' });
  }

  async delete(id: string): Promise<void> {
    await this.graph.request(`/me/events/${id}`, { method: 'DELETE', label: 'calendar.delete' });
  }

  async respond(id: string, response: 'accept' | 'tentativelyAccept' | 'decline', comment = '', sendResponse = true): Promise<void> {
    await this.graph.request(`/me/events/${id}/${response}`, {
      method: 'POST', body: { comment, sendResponse }, label: `calendar.${response}`,
    });
  }
}
