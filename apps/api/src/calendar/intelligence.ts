import type { CalendarEvent } from '../graph/calendar.service.js';

export interface ProposedTime {
  start: string;
  end: string;
  timezone: string;
}

export interface CalendarConflict {
  id: string;
  subject: string;
  start: string;
  end: string;
  isAllDay: boolean;
}

export interface ScheduleAvailability {
  scheduleId: string;
  availabilityView: string;
}

function wallClock(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    const [date, time] = value.split('T');
    const [year, month, day] = date!.split('-').map(Number);
    const [hour, minute, second = 0] = time!.split(':').map(Number);
    return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  }
  return Date.parse(value);
}

function validRange(start: string, end: string): { start: number; end: number } | null {
  const from = wallClock(start);
  const to = wallClock(end);
  return Number.isFinite(from) && Number.isFinite(to) && from < to ? { start: from, end: to } : null;
}

export function findCalendarConflicts(
  proposal: ProposedTime,
  events: CalendarEvent[],
  excludeId?: string,
): CalendarConflict[] {
  const requested = validRange(proposal.start, proposal.end);
  if (!requested) return [];
  return events.flatMap((event) => {
    if (event.id === excludeId || event.isCancelled) return [];
    const occupied = validRange(event.start, event.end);
    if (!occupied || requested.start >= occupied.end || requested.end <= occupied.start) return [];
    return [{ id: event.id, subject: event.subject, start: event.start, end: event.end, isAllDay: event.isAllDay }];
  }).sort((a, b) => a.start.localeCompare(b.start));
}

function timeOnDay(day: number, hhmm: string): number {
  const [hour = 0, minute = 0] = hhmm.split(':').map(Number);
  const date = new Date(day);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Intersect Graph availability views without inferring attendee availability. */
export function recommendAvailableSlots(input: {
  start: string;
  end: string;
  timezone: string;
  durationMinutes: number;
  intervalMinutes: number;
  schedules: ScheduleAvailability[];
  workingHours?: { daysOfWeek: string[]; startTime: string; endTime: string } | null;
  limit?: number;
}): Array<{ start: string; end: string; timezone: string }> {
  const range = validRange(input.start, input.end);
  if (!range || input.durationMinutes <= 0 || input.intervalMinutes <= 0 || input.schedules.length === 0) return [];
  const intervalMs = input.intervalMinutes * 60_000;
  const needed = Math.ceil(input.durationMinutes / input.intervalMinutes);
  const slots = Math.ceil((range.end - range.start) / intervalMs);
  const available = Array.from({ length: slots }, (_, index) =>
    input.schedules.every((schedule) => (schedule.availabilityView[index] ?? '2') === '0'),
  );
  const work = input.workingHours ?? {
    daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startTime: '09:00', endTime: '17:00',
  };
  const results: Array<{ start: string; end: string; timezone: string }> = [];
  for (let index = 0; index + needed <= available.length && results.length < (input.limit ?? 5); index++) {
    if (!available.slice(index, index + needed).every(Boolean)) continue;
    const start = range.start + index * intervalMs;
    const end = start + input.durationMinutes * 60_000;
    const date = new Date(start);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (!work.daysOfWeek.map((day) => day.toLowerCase()).includes(DAYS[date.getUTCDay()]!)) continue;
    if (start < timeOnDay(dayStart, work.startTime) || end > timeOnDay(dayStart, work.endTime)) continue;
    results.push({
      start: new Date(start).toISOString().replace('.000Z', ''),
      end: new Date(end).toISOString().replace('.000Z', ''),
      timezone: input.timezone,
    });
    index += needed - 1;
  }
  return results;
}
