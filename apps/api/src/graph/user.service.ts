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
}

interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  jobTitle?: string | null;
}

interface GraphMailboxSettings {
  timeZone?: string;
  workingHours?: {
    daysOfWeek?: string[];
    startTime?: string;
    endTime?: string;
    timeZone?: { name?: string };
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
      query: { $select: 'timeZone,workingHours' },
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
    };
  }
}
