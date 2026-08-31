/**
 * Conversation persistence.
 *
 * Falls back to memory when the database is absent, so the app still runs
 * during setup — the fallback announces itself and loses everything on restart.
 */
import { hasDb, requireDb } from '../db/index.js';
import { randomId } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { isUuid } from '../lib/errors.js';
import type { ActionPreview } from '../agent/tools/types.js';

export interface StoredApproval {
  id: string;
  preview: ActionPreview;
  expiresAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  pinned: boolean;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps: { tool: string; summary: string; status: 'success' | 'failed' | 'approval_required' }[];
  approval?: StoredApproval;
  model: string | null;
  durationMs: number | null;
  wasBlocked: boolean;
  createdAt: string;
}

export interface AppendArgs {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: StoredMessage['steps'];
  approval?: StoredApproval;
  model?: string | null;
  durationMs?: number | null;
  wasBlocked?: boolean;
}

/**
 * Historical rows predate the current step schema. Postgres JSONB normally
 * returns an array, but old imports may contain a JSON string or wrapper
 * object. Normalise at the API boundary so a bad row cannot crash chat history.
 */
export function normaliseSteps(value: unknown): StoredMessage['steps'] {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return [];
    }
  }
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'steps' in candidate) {
    candidate = (candidate as { steps?: unknown }).steps;
  }
  if (!Array.isArray(candidate)) return [];

  return candidate.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.tool !== 'string' || typeof row.summary !== 'string') return [];
    const status = row.status === 'success' || row.status === 'approval_required' ? row.status : 'failed';
    return [{ tool: row.tool, summary: row.summary, status }];
  });
}

/** A readable title from her first message, without calling the model. */
export function deriveTitle(firstMessage: string): string {
  const cleaned = firstMessage.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 48) return cleaned || 'New conversation';

  // Prefer cutting at a word boundary.
  const cut = cleaned.slice(0, 48);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// ---------------------------------------------------------------- memory ---

interface MemoryConvo extends ConversationSummary {
  userId: string;
  messages: StoredMessage[];
}

const memory = new Map<string, MemoryConvo>();

// -------------------------------------------------------------- interface ---

export async function listConversations(userId: string, limit = 50): Promise<ConversationSummary[]> {
  if (!hasDb()) {
    return [...memory.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .slice(0, limit)
      .map(({ userId: _u, messages: _m, ...rest }) => rest);
  }

  const db = requireDb();
  const rows = await db<
    { id: string; title: string; message_count: number; last_message_at: Date; pinned: boolean }[]
  >`
    select id, title, message_count, last_message_at, pinned
    from conversations
    where user_id = ${userId} and archived_at is null
    order by pinned desc, last_message_at desc
    limit ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    messageCount: r.message_count,
    lastMessageAt: r.last_message_at.toISOString(),
    pinned: r.pinned,
  }));
}

export async function createConversation(userId: string, title: string): Promise<string> {
  if (!hasDb()) {
    const id = randomId(12);
    memory.set(id, {
      id,
      userId,
      title,
      messageCount: 0,
      lastMessageAt: new Date().toISOString(),
      pinned: false,
      messages: [],
    });
    return id;
  }

  const db = requireDb();
  const rows = await db<{ id: string }[]>`
    insert into conversations (user_id, title) values (${userId}, ${title}) returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('Could not create conversation.');
  return id;
}

export async function getMessages(userId: string, conversationId: string): Promise<StoredMessage[]> {
  if (!hasDb()) {
    const convo = memory.get(conversationId);
    return convo && convo.userId === userId ? convo.messages : [];
  }

  if (!isUuid(conversationId)) return [];

  const db = requireDb();
  const rows = await db<
    {
      id: string;
      role: string;
      content: string;
      steps: unknown;
      approval: unknown;
      model: string | null;
      duration_ms: number | null;
      was_blocked: boolean;
      created_at: Date;
    }[]
  >`
    select m.id, m.role, m.content, m.steps, m.approval, m.model, m.duration_ms, m.was_blocked, m.created_at
    from conversation_messages m
    join conversations c on c.id = m.conversation_id
    where m.conversation_id = ${conversationId} and c.user_id = ${userId}
    order by m.created_at asc
    limit 200
  `;

  return rows.map((r) => ({
    id: r.id,
    role: r.role === 'user' ? 'user' : 'assistant',
    content: r.content,
    steps: normaliseSteps(r.steps),
    approval: normaliseStoredApproval(r.approval),
    model: r.model,
    durationMs: r.duration_ms,
    wasBlocked: r.was_blocked,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function appendMessage(args: AppendArgs): Promise<void> {
  if (!hasDb()) {
    const convo = memory.get(args.conversationId);
    if (!convo) return;
    convo.messages.push({
      id: randomId(8),
      role: args.role,
      content: args.content,
      steps: args.steps ?? [],
      approval: args.approval,
      model: args.model ?? null,
      durationMs: args.durationMs ?? null,
      wasBlocked: args.wasBlocked ?? false,
      createdAt: new Date().toISOString(),
    });
    convo.messageCount++;
    convo.lastMessageAt = new Date().toISOString();
    return;
  }

  try {
    const db = requireDb();
    await db`
      insert into conversation_messages (conversation_id, role, content, steps, approval, model, duration_ms, was_blocked)
      values (
        ${args.conversationId}, ${args.role}, ${args.content},
        ${JSON.stringify(args.steps ?? [])}::jsonb,
        ${args.approval ? JSON.stringify(args.approval) : null}::jsonb,
        ${args.model ?? null}, ${args.durationMs ?? null}, ${args.wasBlocked ?? false}
      )
    `;
  } catch (err) {
    logger.error({ err, conversationId: args.conversationId }, 'Could not save message');
  }
}

export function normaliseStoredApproval(value: unknown): StoredApproval | undefined {
  let candidate = value;
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate); } catch { return undefined; }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const row = candidate as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.expiresAt !== 'string') return undefined;
  if (!row.preview || typeof row.preview !== 'object' || Array.isArray(row.preview)) return undefined;
  const preview = row.preview as Record<string, unknown>;
  if (typeof preview.title !== 'string' || typeof preview.summary !== 'string' || !Array.isArray(preview.details)) return undefined;
  const details = preview.details.flatMap((detail) => {
    if (!detail || typeof detail !== 'object') return [];
    const item = detail as Record<string, unknown>;
    return typeof item.label === 'string' && typeof item.value === 'string'
      ? [{ label: item.label, value: item.value }]
      : [];
  });
  return {
    id: row.id,
    expiresAt: row.expiresAt,
    preview: {
      title: preview.title,
      summary: preview.summary,
      details,
      ...(typeof preview.warning === 'string' ? { warning: preview.warning } : {}),
    },
  };
}

export async function ownsConversation(userId: string, conversationId: string): Promise<boolean> {
  if (!hasDb()) return memory.get(conversationId)?.userId === userId;

  // Postgres raises on a malformed uuid; a made-up id simply is not ours.
  if (!isUuid(conversationId)) return false;

  const db = requireDb();
  const rows = await db<{ id: string }[]>`
    select id from conversations where id = ${conversationId} and user_id = ${userId} limit 1
  `;
  return rows.length > 0;
}

export async function renameConversation(userId: string, conversationId: string, title: string): Promise<void> {
  if (!hasDb()) {
    const convo = memory.get(conversationId);
    if (convo && convo.userId === userId) convo.title = title;
    return;
  }
  const db = requireDb();
  await db`update conversations set title = ${title} where id = ${conversationId} and user_id = ${userId}`;
}

export async function archiveConversation(userId: string, conversationId: string): Promise<void> {
  if (!hasDb()) {
    const convo = memory.get(conversationId);
    if (convo && convo.userId === userId) memory.delete(conversationId);
    return;
  }
  const db = requireDb();
  await db`update conversations set archived_at = now() where id = ${conversationId} and user_id = ${userId}`;
}

export async function togglePin(userId: string, conversationId: string): Promise<void> {
  if (!hasDb()) {
    const convo = memory.get(conversationId);
    if (convo && convo.userId === userId) convo.pinned = !convo.pinned;
    return;
  }
  const db = requireDb();
  await db`update conversations set pinned = not pinned where id = ${conversationId} and user_id = ${userId}`;
}
