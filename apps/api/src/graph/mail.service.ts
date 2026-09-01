import type { GraphClient } from './client.js';
import { extractSafeText, MAX_EXTERNAL_FILE_BYTES, safeFileName, supportsTextExtraction, type ExtractedText } from '../content/safe-text.js';

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
  bccRecipients: MailAddress[];
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

export interface MailAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  kind: 'file' | 'item' | 'reference' | 'unknown';
  textSupported: boolean;
  lastModifiedAt: string;
}

interface GraphAttachment {
  '@odata.type'?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  lastModifiedDateTime?: string;
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
  bccRecipients?: GraphRecipient[];
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
  'id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,importance,bodyPreview,webLink';

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
  folder?: 'inbox' | 'sentitems' | 'drafts' | 'archive' | 'deleteditems';
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
      bccRecipients: toAddresses(m.bccRecipients),
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

  /**
   * Read only what changed in a folder since the last call.
   *
   * The delta link is an opaque Graph continuation URL. It is treated strictly
   * as a cursor: stored, replayed, never parsed. Passing null starts a fresh
   * enumeration, which Graph answers with the current state and a new link.
   *
   * Pages are followed to a bound rather than exhaustively — a first sync on a
   * large mailbox would otherwise walk the entire folder in one request. When
   * the bound is hit, `deltaLink` is null and `more` is true, and the caller is
   * expected to come back for the rest.
   */
  async delta(input: { folder?: string; deltaLink?: string | null; maxPages?: number } = {}): Promise<{
    messages: MailMessage[];
    deltaLink: string | null;
    more: boolean;
  }> {
    const folder = input.folder ?? 'inbox';
    const maxPages = input.maxPages ?? 5;

    let next: string | undefined = input.deltaLink ?? `/me/mailFolders/${folder}/messages/delta`;
    const collected: GraphMessage[] = [];
    let deltaLink: string | null = null;
    let page = 0;

    while (next && page < maxPages) {
      const response: {
        value?: GraphMessage[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      } = await this.graph.request(next, {
        // $select keeps each delta page small; the body is never needed here.
        ...(page === 0 && !input.deltaLink ? { query: { $select: LIST_SELECT } } : {}),
        label: 'mail.delta',
      });

      if (response.value) collected.push(...response.value);
      deltaLink = response['@odata.deltaLink'] ?? null;
      next = response['@odata.nextLink'];
      page++;
    }

    return {
      // A delta page includes removals, which carry no usable fields. Keep only
      // rows that actually describe a message.
      messages: collected.filter((m) => m.id && m.receivedDateTime).map((m) => this.shape(m)),
      deltaLink,
      more: Boolean(next),
    };
  }

  private shapeAttachment(a: GraphAttachment): MailAttachment {
    const graphType = a['@odata.type'] ?? '';
    const kind = graphType.includes('fileAttachment') ? 'file'
      : graphType.includes('itemAttachment') ? 'item'
        : graphType.includes('referenceAttachment') ? 'reference' : 'unknown';
    const name = safeFileName(a.name);
    return {
      id: a.id,
      name,
      contentType: a.contentType ?? 'application/octet-stream',
      size: Math.max(0, a.size ?? 0),
      isInline: a.isInline ?? false,
      kind,
      textSupported: kind === 'file' && supportsTextExtraction(name, a.contentType),
      lastModifiedAt: a.lastModifiedDateTime ?? '',
    };
  }

  async listAttachments(messageId: string): Promise<MailAttachment[]> {
    const rows = await this.graph.collect<GraphAttachment>(
      `/me/messages/${encodeURIComponent(messageId)}/attachments`,
      { query: { $select: 'id,name,contentType,size,isInline,lastModifiedDateTime' }, label: 'mail.attachments.list' },
      2,
    );
    return rows.map((row) => this.shapeAttachment(row));
  }

  async readAttachmentText(input: {
    messageId: string;
    attachmentId: string;
    startCharacter?: number;
    maxCharacters?: number;
  }): Promise<MailAttachment & ExtractedText> {
    const metadata = await this.graph.request<GraphAttachment>(
      `/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
      { query: { $select: 'id,name,contentType,size,isInline,lastModifiedDateTime' }, label: 'mail.attachment.metadata' },
    );
    const attachment = this.shapeAttachment(metadata);
    if (!attachment.textSupported || attachment.kind !== 'file') {
      return Promise.reject(new Error(`I cannot safely extract text from ${attachment.name}.`));
    }
    if (attachment.size > MAX_EXTERNAL_FILE_BYTES) {
      return Promise.reject(new Error(`${attachment.name} is larger than the 5 MB inspection limit.`));
    }
    const file = await this.graph.requestBytes(
      `/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}/$value`,
      { maxBytes: MAX_EXTERNAL_FILE_BYTES, label: 'mail.attachment.content' },
    );
    const extracted = extractSafeText({
      bytes: file.bytes,
      name: attachment.name,
      contentType: attachment.contentType || file.contentType,
      startCharacter: input.startCharacter,
      maxCharacters: input.maxCharacters,
    });
    return { ...attachment, ...extracted };
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

  async listFolders(): Promise<Array<{ id: string; name: string; unread: number; total: number }>> {
    const rows = await this.graph.collect<{ id: string; displayName?: string; unreadItemCount?: number; totalItemCount?: number }>(
      '/me/mailFolders',
      { query: { $select: 'id,displayName,unreadItemCount,totalItemCount', $top: 100 }, label: 'mail.folders' },
      2,
    );
    return rows.map((f) => ({ id: f.id, name: f.displayName ?? 'Folder', unread: f.unreadItemCount ?? 0, total: f.totalItemCount ?? 0 }));
  }

  async getFolder(id: string): Promise<{ id: string; name: string }> {
    const folder = await this.graph.request<{ id: string; displayName?: string }>(`/me/mailFolders/${id}`, {
      query: { $select: 'id,displayName' }, label: 'mail.folder.get',
    });
    return { id: folder.id, name: folder.displayName ?? 'Folder' };
  }

  async createDraft(input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }): Promise<{ id: string; subject: string }> {
    const message = await this.graph.request<GraphMessage>('/me/messages', {
      method: 'POST',
      body: {
        subject: input.subject,
        body: { contentType: 'Text', content: input.body },
        toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
        ccRecipients: (input.cc ?? []).map((address) => ({ emailAddress: { address } })),
        bccRecipients: (input.bcc ?? []).map((address) => ({ emailAddress: { address } })),
      },
      label: 'mail.createDraft',
    });
    return { id: message.id, subject: message.subject ?? input.subject };
  }

  async createReplyDraft(messageId: string, body: string): Promise<{ id: string; subject: string }> {
    const draft = await this.graph.request<GraphMessage>(`/me/messages/${messageId}/createReply`, {
      method: 'POST', body: { comment: body }, label: 'mail.createReplyDraft',
    });
    return { id: draft.id, subject: draft.subject ?? 'Reply' };
  }

  async send(input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }): Promise<void> {
    await this.graph.request<void>('/me/sendMail', {
      method: 'POST',
      body: {
        message: {
          subject: input.subject,
          body: { contentType: 'Text', content: input.body },
          toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
          ccRecipients: (input.cc ?? []).map((address) => ({ emailAddress: { address } })),
          bccRecipients: (input.bcc ?? []).map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      },
      label: 'mail.send',
    });
  }

  async reply(messageId: string, body: string, replyAll = false): Promise<void> {
    await this.graph.request<void>(`/me/messages/${messageId}/${replyAll ? 'replyAll' : 'reply'}`, {
      method: 'POST', body: { comment: body }, label: replyAll ? 'mail.replyAll' : 'mail.reply',
    });
  }

  async forward(messageId: string, to: string[], comment: string): Promise<void> {
    await this.graph.request<void>(`/me/messages/${messageId}/forward`, {
      method: 'POST',
      body: { comment, toRecipients: to.map((address) => ({ emailAddress: { address } })) },
      label: 'mail.forward',
    });
  }

  async sendDraft(messageId: string): Promise<void> {
    await this.graph.request<void>(`/me/messages/${messageId}/send`, { method: 'POST', label: 'mail.sendDraft' });
  }

  async setRead(messageId: string, isRead: boolean): Promise<void> {
    await this.graph.request(`/me/messages/${messageId}`, { method: 'PATCH', body: { isRead }, label: 'mail.setRead' });
  }

  async setFlag(messageId: string, flagged: boolean): Promise<void> {
    await this.graph.request(`/me/messages/${messageId}`, {
      method: 'PATCH', body: { flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } }, label: 'mail.setFlag',
    });
  }

  async move(messageId: string, destinationId: string): Promise<void> {
    await this.graph.request(`/me/messages/${messageId}/move`, {
      method: 'POST', body: { destinationId }, label: 'mail.move',
    });
  }

  async delete(messageId: string): Promise<void> {
    await this.graph.request(`/me/messages/${messageId}`, { method: 'DELETE', label: 'mail.delete' });
  }
}
