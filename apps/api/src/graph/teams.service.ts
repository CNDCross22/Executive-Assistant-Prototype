import type { GraphClient } from './client.js';
import { htmlToText } from './mail.service.js';

export interface TeamSummary { id: string; name: string; description: string; }
export interface ChannelSummary { id: string; name: string; description: string; membershipType: string; }
export interface ChannelMessageSummary { id: string; createdAt: string; modifiedAt: string; from: string; subject: string; text: string; }

interface GraphTeam { id: string; displayName?: string; description?: string; }
interface GraphChannel { id: string; displayName?: string; description?: string; membershipType?: string; }
interface GraphChannelMessage {
  id: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  subject?: string | null;
  body?: { content?: string; contentType?: string };
  from?: { user?: { displayName?: string }; application?: { displayName?: string }; device?: { displayName?: string } };
}

/** Read-only Microsoft Teams surface. No send, edit, delete or membership operations. */
export class TeamsService {
  constructor(private readonly graph: GraphClient) {}

  async listJoinedTeams(limit = 50): Promise<TeamSummary[]> {
    // Microsoft currently rejects OData options on /me/joinedTeams.
    const rows = await this.graph.collect<GraphTeam>('/me/joinedTeams', {
      label: 'teams.joined.list',
    }, 5);
    return rows.slice(0, limit).map((team) => ({
      id: team.id,
      name: team.displayName?.trim() || 'Unnamed team',
      description: (team.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    }));
  }

  async listChannels(teamId: string, limit = 100): Promise<ChannelSummary[]> {
    const rows = await this.graph.collect<GraphChannel>(`/teams/${encodeURIComponent(teamId)}/channels`, {
      // Channel listing supports $select and $filter, but not $top.
      query: { $select: 'id,displayName,description,membershipType' },
      label: 'teams.channels.list',
    }, Math.ceil(limit / 50));
    return rows.slice(0, limit).map((channel) => ({
      id: channel.id,
      name: channel.displayName?.trim() || 'Unnamed channel',
      description: (channel.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      membershipType: channel.membershipType ?? 'standard',
    }));
  }

  async listChannelMessages(teamId: string, channelId: string, limit = 25): Promise<ChannelMessageSummary[]> {
    const rows = await this.graph.collect<GraphChannelMessage>(
      `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
      { query: { $top: Math.min(limit, 50) }, label: 'teams.messages.list' },
      Math.ceil(limit / 50),
    );
    return rows.slice(0, limit).map((message) => {
      const raw = message.body?.content ?? '';
      const text = (message.body?.contentType ?? 'html').toLowerCase() === 'html' ? htmlToText(raw) : raw.trim();
      return {
        id: message.id,
        createdAt: message.createdDateTime ?? '',
        modifiedAt: message.lastModifiedDateTime ?? '',
        from: message.from?.user?.displayName ?? message.from?.application?.displayName ?? message.from?.device?.displayName ?? 'Unknown sender',
        subject: message.subject?.trim() || '',
        text: text.slice(0, 4_000),
      };
    });
  }
}
