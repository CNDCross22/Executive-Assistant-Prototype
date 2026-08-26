import type { GraphClient } from './client.js';

/**
 * Application-shaped mail objects.
 *
 * `bodyPreview` and `body` are UNTRUSTED external content. Anything that puts
 * them near a model must label them as data, never as instructions.
 */
export interface MailAddress {
  name: string;
  address: string;
}

export interface MailMessage {
  id: string;
  conversationId: string;
  subject: string;
  from: MailAddress | null;
  toRecipients: MailAddress[];
  ccRecipients: MailAddress[];
  receivedAt: string;
  sentAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: 'low' | 'normal' | 'high';
  bodyPreview: string;
  webLink: string;
  /** True when the message came from outside the tenant. */
  isExternal: boolean;
}

export interface MailMessageDetail extends MailMessage {
  body: string;
  bodyType: 'text' | 'html';
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string | null;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  importance?: string;
  bodyPreview?: string;
  webLink?: string;
  body?: { contentType?: string; content?: string };
}

const LIST_SELECT =
  'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,importance,bodyPreview,webLink';

function toAddress(r: GraphRecipient | undefined): MailAddress | null {
  const a = r?.emailAddress;
  if (!a?.address) return null;
  return { name: a.name ?? a.address, address: a.address.toLowerCase() };
}

function toAddresses(list: GraphRecipient[] | undefined): MailAddress[] {
  return (list ?? []).map(toAddress).filter((a): a is MailAddress => a !== null);
}

/** Crude but effective HTML to text, so we never feed markup to a model. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ListMailOptions {
  folder?: 'inbox' | 'sentitems' | 'drafts';
  limit?: number;
  unreadOnly?: boolean;
  /** ISO date; only messages received at or after this. */
  since?: string;
}

export class MailService {
  constructor(
    private readonly graph: GraphClient,
    /** Used to decide whether a sender is internal. */
    private readonly ownDomain: string,
  ) {}

  private shape(m: GraphMessage): MailMessage {
    const from = toAddress(m.from ?? m.sender);
    const domain = from?.address.split('@')[1] ?? '';
    return {
      id: m.id,
      conversationId: m.conversationId ?? '',
      subject: m.subject?.trim() || '(no subject)',
      from,
      toRecipients: toAddresses(m.toRecipients),
      ccRecipients: toAddresses(m.ccRecipients),
      receivedAt: m.receivedDateTime ?? '',
      sentAt: m.sentDateTime ?? '',
      isRead: m.isRead ?? false,
      hasAttachments: m.hasAttachments ?? false,
      importance: (m.importance as MailMessage['importance']) ?? 'normal',
      bodyPreview: (m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
      webLink: m.webLink ?? '',
      isExternal: Boolean(domain) && domain !== this.ownDomain,
    };
  }

  async list(options: ListMailOptions = {}): Promise<MailMessage[]> {
    const { folder = 'inbox', limit = 25, unreadOnly = false, since } = options;

    const filters: string[] = [];
    if (unreadOnly) filters.push('isRead eq false');
    if (since) filters.push(`receivedDateTime ge ${new Date(since).toISOString()}`);

    const messages = await this.graph.collect<GraphMessage>(
      `/me/mailFolders/${folder}/messages`,
      {
        query: {
          $select: LIST_SELECT,
          $top: Math.min(limit, 50),
          $orderby: 'receivedDateTime desc',
          $filter: filters.length ? filters.join(' and ') : undefined,
        },
        label: 'mail.list',
      },
      Math.ceil(limit / 50),
    );

    return messages.slice(0, limit).map((m) => this.shape(m));
  }

  /**
   * Full-text search across the mailbox. Graph forbids $orderby with $search,
   * so results come back relevance-ordered and we sort by date ourselves.
   */
  async search(query: string, limit = 20): Promise<MailMessage[]> {
    const messages = await this.graph.collect<GraphMessage>(
      '/me/messages',
      {
        query: {
          $search: `"${query.replace(/"/g, '')}"`,
          $select: LIST_SELECT,
          $top: Math.min(limit, 50),
        },
        headers: { ConsistencyLevel: 'eventual' },
        label: 'mail.search',
      },
      1,
    );

    return messages
      .map((m) => this.shape(m))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  async get(id: string): Promise<MailMessageDetail> {
    const m = await this.graph.request<GraphMessage>(`/me/messages/${id}`, {
      query: { $select: `${LIST_SELECT},body` },
      label: 'mail.get',
    });

    const raw = m.body?.content ?? '';
    const isHtml = (m.body?.contentType ?? 'text').toLowerCase() === 'html';

    return {
      ...this.shape(m),
      body: isHtml ? htmlToText(raw) : raw.trim(),
      bodyType: isHtml ? 'html' : 'text',
    };
  }

  /** Every message in one thread, oldest first. */
  async thread(conversationId: string, limit = 20): Promise<MailMessage[]> {
    const messages = await this.graph.collect<GraphMessage>(
      '/me/messages',
      {
        query: {
          $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
          $select: LIST_SELECT,
          $top: Math.min(limit, 50),
        },
        label: 'mail.thread',
      },
      1,
    );

    return messages
      .map((m) => this.shape(m))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }
}
