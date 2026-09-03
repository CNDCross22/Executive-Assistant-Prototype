import type { GraphClient } from './client.js';
import { MAX_EXTERNAL_FILE_BYTES, safeFileName } from '../content/safe-text.js';
import { extractDocumentText, supportsExtraction, SUPPORTED_FORMATS_SENTENCE, type ExtractedDocument } from '../content/documents.js';
import { isVisionReadable } from '../content/vision.js';

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
  /** Text can be extracted from it directly. */
  textSupported: boolean;
  /** Readable at all: by extraction, or by looking at the page. */
  readable: boolean;
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

/**
 * How a drafted message body is set.
 *
 * Stated explicitly on every paragraph rather than left to the client. Outlook
 * applies a theme colour to reply text, which rendered the message in a dark
 * brown rather than black, and an unstyled paragraph inherits whatever the
 * recipient's client decides. Inline styles are also the only kind that
 * survive: a <style> block is stripped by most mail clients.
 *
 * Aptos is the current Outlook default; Calibri is the previous one and the
 * fallback for a client that does not have Aptos.
 */
const BODY_STYLE = [
  'font-family: Aptos, Calibri, sans-serif',
  'font-size: 11pt',
  'color: #000000',
  // The blank line between sections. Outlook injects
  // `<style>p { margin-top:0; margin-bottom:0 }</style>` into every reply
  // body, which collapses the gap and stacks the greeting, message and
  // sign-off against each other. An inline declaration outranks that block,
  // so the spacing has to be stated here to survive.
  'margin: 0 0 11pt 0',
].join('; ');

/**
 * Plain text as minimal HTML, preserving the shape the author wrote.
 *
 * A reply body is HTML, and Graph inserts a plain-text `comment` into it
 * verbatim — so every newline becomes ordinary whitespace and a greeting,
 * message and sign-off collapse onto one line. Verified against the live
 * tenant, not assumed.
 *
 * The text is escaped before it is given structure, so nothing in a drafted
 * message can introduce markup.
 */
export function textToHtml(plain: string): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const paragraphs = plain
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="${BODY_STYLE}">${escape(block).replace(/\n/g, '<br>')}</p>`);

  return paragraphs.join('') || `<p style="${BODY_STYLE}"></p>`;
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
   * Fetch several messages in full using one request.
   *
   * The whole-inbox summary read up to twenty messages one at a time, four in
   * parallel, before the model had written a word. Graph's $batch carries up
   * to twenty requests in a single round trip, which is the difference between
   * one wait and five.
   *
   * A message that fails inside the batch is omitted rather than throwing: a
   * summary of nineteen messages beats an error over one unreadable item.
   */
  async getMany(ids: string[]): Promise<Map<string, MailMessageDetail>> {
    const found = new Map<string, MailMessageDetail>();
    if (ids.length === 0) return found;

    // Graph caps a batch at twenty requests.
    for (let offset = 0; offset < ids.length; offset += 20) {
      const chunk = ids.slice(offset, offset + 20);
      const response = await this.graph.request<{
        responses?: Array<{ id: string; status: number; body?: GraphMessage }>;
      }>('/$batch', {
        method: 'POST',
        body: {
          requests: chunk.map((id, index) => ({
            id: String(index),
            method: 'GET',
            url: `/me/messages/${id}?$select=${LIST_SELECT},body`,
          })),
        },
        label: 'mail.getMany',
        // Reads only, so a transient failure is safe to try again.
        retry: 'safe',
      });

      for (const item of response.responses ?? []) {
        if (item.status !== 200 || !item.body) continue;
        const raw = item.body.body?.content ?? '';
        const isHtml = (item.body.body?.contentType ?? 'text').toLowerCase() === 'html';
        const shaped = {
          ...this.shape(item.body),
          body: isHtml ? htmlToText(raw) : raw.trim(),
          bodyType: (isHtml ? 'html' : 'text') as 'html' | 'text',
        };
        found.set(chunk[Number(item.id)]!, shaped);
      }
    }

    return found;
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
      textSupported: kind === 'file' && supportsExtraction(name, a.contentType),
      // Readable at all, by extraction or by looking at it.
      readable: kind === 'file' && (supportsExtraction(name, a.contentType) || isVisionReadable(name, a.contentType)),
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

  /**
   * Download one attachment.
   *
   * Split out from reading it so the tool layer can fall back to looking at a
   * page when there is no text on it. Keeping that decision above this service
   * is deliberate: nothing here should reach for the paid model, because the
   * same service backs the deterministic triage that runs on every change.
   */
  async attachmentBytes(input: {
    messageId: string;
    attachmentId: string;
  }): Promise<{ attachment: MailAttachment; bytes: Uint8Array; contentType: string }> {
    const metadata = await this.graph.request<GraphAttachment>(
      `/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
      { query: { $select: 'id,name,contentType,size,isInline,lastModifiedDateTime' }, label: 'mail.attachment.metadata' },
    );
    const attachment = this.shapeAttachment(metadata);
    if (!attachment.readable || attachment.kind !== 'file') {
      throw new Error(`I cannot read ${attachment.name}. ${SUPPORTED_FORMATS_SENTENCE}`);
    }
    if (attachment.size > MAX_EXTERNAL_FILE_BYTES) {
      throw new Error(`${attachment.name} is larger than the 5 MB inspection limit.`);
    }
    const file = await this.graph.requestBytes(
      `/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}/$value`,
      { maxBytes: MAX_EXTERNAL_FILE_BYTES, label: 'mail.attachment.content' },
    );
    return { attachment, bytes: file.bytes, contentType: attachment.contentType || file.contentType };
  }

  async readAttachmentText(input: {
    messageId: string;
    attachmentId: string;
    startCharacter?: number;
    maxCharacters?: number;
  }): Promise<MailAttachment & ExtractedDocument> {
    const { attachment, bytes, contentType } = await this.attachmentBytes(input);
    const extracted = await extractDocumentText({
      bytes,
      name: attachment.name,
      contentType,
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

  /**
   * Build a reply draft whose body keeps the line breaks the author wrote.
   *
   * Passing the text as `comment` would be one call instead of two, but Graph
   * inserts it into an HTML body unchanged and the formatting is lost. So the
   * draft is created empty, its own content type is read rather than assumed,
   * and the text is formatted to match before being prepended to the quoted
   * conversation.
   */
  private async buildReplyDraft(
    messageId: string,
    body: string,
    replyAll: boolean,
  ): Promise<{ id: string; subject: string }> {
    const action = replyAll ? 'createReplyAll' : 'createReply';
    const draft = await this.graph.request<GraphMessage>(`/me/messages/${messageId}/${action}`, {
      method: 'POST', label: `mail.${action}`, retry: 'never',
    });

    const quoted = draft.body?.content ?? '';
    const isHtml = (draft.body?.contentType ?? 'html').toLowerCase() === 'html';
    const content = isHtml ? `${textToHtml(body)}${quoted}` : `${body}\n\n${quoted}`;

    await this.graph.request(`/me/messages/${draft.id}`, {
      method: 'PATCH',
      body: { body: { contentType: isHtml ? 'HTML' : 'Text', content } },
      label: 'mail.replyDraft.patch',
      retry: 'never',
    });

    return { id: draft.id, subject: draft.subject ?? 'Reply' };
  }

  async createReplyDraft(messageId: string, body: string): Promise<{ id: string; subject: string }> {
    return this.buildReplyDraft(messageId, body, false);
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

  /**
   * Reply, keeping the author's formatting.
   *
   * Built as a draft and then sent, because the one-shot endpoint only accepts
   * a plain `comment` and loses the line breaks. Send is therefore not atomic:
   * a failure after the draft exists leaves it in Drafts rather than sending
   * twice, which is the safer direction to fail in.
   */
  async reply(messageId: string, body: string, replyAll = false): Promise<void> {
    const draft = await this.buildReplyDraft(messageId, body, replyAll);
    await this.sendDraft(draft.id);
  }

  async forward(messageId: string, to: string[], comment: string): Promise<void> {
    const draft = await this.graph.request<GraphMessage>(`/me/messages/${messageId}/createForward`, {
      method: 'POST',
      body: { toRecipients: to.map((address) => ({ emailAddress: { address } })) },
      label: 'mail.createForward',
      retry: 'never',
    });

    const quoted = draft.body?.content ?? '';
    const isHtml = (draft.body?.contentType ?? 'html').toLowerCase() === 'html';
    const content = isHtml ? `${textToHtml(comment)}${quoted}` : `${comment}\n\n${quoted}`;

    await this.graph.request(`/me/messages/${draft.id}`, {
      method: 'PATCH',
      body: { body: { contentType: isHtml ? 'HTML' : 'Text', content } },
      label: 'mail.forwardDraft.patch',
      retry: 'never',
    });

    await this.sendDraft(draft.id);
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
