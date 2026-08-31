import type { GraphClient } from './client.js';
import { toIana } from '../lib/timezone.js';

export interface UserProfile {
  msUserId: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
}

export interface MailboxSettings {
  timezone: string;
  workingHours: {
    daysOfWeek: string[];
    startTime: string;
    endTime: string;
    timezone: string;
  } | null;
  automaticReplies?: {
    status: 'disabled' | 'alwaysEnabled' | 'scheduled';
    externalAudience: 'none' | 'contactsOnly' | 'all';
    internalMessage: string;
    externalMessage: string;
    start?: string;
    end?: string;
  };
}

interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  jobTitle?: string | null;
}

export interface DirectoryPerson {
  name: string;
  email: string;
  jobTitle: string | null;
}

function normalisePersonText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Keep attendee resolution inside the Director's organisation and rank exact names first. */
export function organisationDirectoryMatches(
  people: DirectoryPerson[],
  query: string,
  organisationDomain: string,
  limit = 10,
): DirectoryPerson[] {
  const domain = organisationDomain.trim().toLowerCase();
  const needle = normalisePersonText(query);
  const tokens = needle.split(/\s+/).filter(Boolean);
  const scored = people.flatMap((person) => {
    const email = person.email.trim().toLowerCase();
    if (!domain || !email.endsWith('@' + domain)) return [];
    const name = normalisePersonText(person.name);
    const local = normalisePersonText(email.split('@')[0] ?? '');
    const fullEmail = normalisePersonText(email);
    const searchable = name + ' ' + local + ' ' + fullEmail;
    let score = 0;
    if (name === needle || local === needle || fullEmail === needle) score = 100;
    else if (name.startsWith(needle) || local.startsWith(needle)) score = 80;
    else if (searchable.includes(needle)) score = 60;
    else if (tokens.length > 0 && tokens.every((token) => searchable.includes(token))) score = 40;
    if (score === 0) return [];
    return [{ person: { ...person, email }, score }];
  });

  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name))
    .flatMap(({ person }) => seen.has(person.email) ? [] : (seen.add(person.email), [person]))
    .slice(0, limit);
}

interface GraphMailboxSettings {
  timeZone?: string;
  workingHours?: {
    daysOfWeek?: string[];
    startTime?: string;
    endTime?: string;
    timeZone?: { name?: string };
  };
  automaticRepliesSetting?: {
    status?: 'disabled' | 'alwaysEnabled' | 'scheduled';
    externalAudience?: 'none' | 'contactsOnly' | 'all';
    internalReplyMessage?: string;
    externalReplyMessage?: string;
    scheduledStartDateTime?: { dateTime?: string; timeZone?: string };
    scheduledEndDateTime?: { dateTime?: string; timeZone?: string };
  };
}

export class UserService {
  constructor(private readonly graph: GraphClient) {}

  async getProfile(): Promise<UserProfile> {
    const u = await this.graph.request<GraphUser>('/me', {
      query: { $select: 'id,displayName,mail,userPrincipalName,jobTitle' },
      label: 'user.getProfile',
    });

    const email = u.mail ?? u.userPrincipalName ?? '';
    return {
      msUserId: u.id,
      displayName: u.displayName ?? email,
      email,
      jobTitle: u.jobTitle ?? null,
    };
  }

  /**
   * Working hours straight from Outlook. The scheduling engine uses these
   * rather than guessing, so "free time" means free by her own definition.
   */
  async getMailboxSettings(): Promise<MailboxSettings> {
    const s = await this.graph.request<GraphMailboxSettings>('/me/mailboxSettings', {
      query: { $select: 'timeZone,workingHours,automaticRepliesSetting' },
      label: 'user.getMailboxSettings',
    });

    // Graph speaks Windows zone names; the rest of the app speaks IANA.
    // Converting here means nothing downstream ever sees a Windows name.
    const wh = s.workingHours;
    return {
      timezone: toIana(s.timeZone),
      workingHours: wh
        ? {
            daysOfWeek: wh.daysOfWeek ?? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            startTime: (wh.startTime ?? '09:00:00').slice(0, 5),
            endTime: (wh.endTime ?? '17:00:00').slice(0, 5),
            timezone: toIana(wh.timeZone?.name ?? s.timeZone),
          }
        : null,
      automaticReplies: s.automaticRepliesSetting ? {
        status: s.automaticRepliesSetting.status ?? 'disabled',
        externalAudience: s.automaticRepliesSetting.externalAudience ?? 'none',
        internalMessage: s.automaticRepliesSetting.internalReplyMessage ?? '',
        externalMessage: s.automaticRepliesSetting.externalReplyMessage ?? '',
        start: s.automaticRepliesSetting.scheduledStartDateTime?.dateTime,
        end: s.automaticRepliesSetting.scheduledEndDateTime?.dateTime,
      } : undefined,
    };
  }

  async updateMailboxSettings(settings: Record<string, unknown>): Promise<void> {
    await this.graph.request('/me/mailboxSettings', { method: 'PATCH', body: settings, label: 'user.updateMailboxSettings' });
  }

  async searchDirectory(query: string, limit = 10): Promise<DirectoryPerson[]> {
    // Keep the value inside Graph's quoted $search expression. The result is
    // filtered to the signed-in organisation again before it reaches the UI.
    const escaped = query.replace(/["\\\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    const rows = await this.graph.collect<GraphUser>('/users', {
      query: {
        $search: `"displayName:${escaped}" OR "mail:${escaped}"`,
        $select: 'id,displayName,mail,userPrincipalName,jobTitle', $count: 'true', $top: Math.min(limit, 25),
      },
      headers: { ConsistencyLevel: 'eventual' }, label: 'user.searchDirectory',
    }, 1);
    return rows.map((u) => ({ name: u.displayName ?? '', email: u.mail ?? u.userPrincipalName ?? '', jobTitle: u.jobTitle ?? null }));
  }

  /**
   * Resolve an employee against the tenant directory, never the looser
   * "relevant people" feed. Enumerating the directory is a fallback for
   * names Graph search tokenises unexpectedly.
   */
  async searchOrganisationDirectory(query: string, organisationDomain: string, limit = 10): Promise<DirectoryPerson[]> {
    const searched = await this.searchDirectory(query, 25);
    const direct = organisationDirectoryMatches(searched, query, organisationDomain, limit);
    if (direct.length > 0) return direct;

    const all = await this.graph.collect<GraphUser>('/users', {
      query: { $select: 'id,displayName,mail,userPrincipalName,jobTitle', $top: 100 },
      label: 'user.listDirectory',
    }, 50);
    const people = all.map((u) => ({
      name: u.displayName ?? '',
      email: u.mail ?? u.userPrincipalName ?? '',
      jobTitle: u.jobTitle ?? null,
    }));
    return organisationDirectoryMatches(people, query, organisationDomain, limit);
  }
}
