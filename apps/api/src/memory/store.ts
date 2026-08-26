/**
 * Memory persistence and retrieval.
 *
 * The governing rule: nothing becomes a durable belief silently. Either she
 * said it, or it was observed repeatedly and she approved it. An assistant
 * that quietly develops opinions about you is unsettling and impossible to
 * correct.
 */
import { hasDb, requireDb } from '../db/index.js';
import { logger } from '../lib/logger.js';

export type MemoryType =
  | 'preference'
  | 'person'
  | 'working_style'
  | 'operational'
  | 'historical'
  | 'procedural';

export type MemoryStatus = 'active' | 'proposed' | 'dismissed' | 'archived';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  key: string | null;
  subject: string | null;
  importance: number;
  confidence: number;
  source: 'explicit' | 'observed' | 'seeded';
  status: MemoryStatus;
  pinned: boolean;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RememberArgs {
  userId: string;
  type: MemoryType;
  title: string;
  content: string;
  key?: string | null;
  subject?: string | null;
  importance?: number;
  confidence?: number;
  source?: MemoryEntry['source'];
  sourceRef?: string | null;
  status?: MemoryStatus;
}

// --- in-memory fallback so the app still works before the database exists ---
const memory: MemoryEntry[] = [];
let nextId = 1;

function rowToEntry(r: Record<string, unknown>): MemoryEntry {
  return {
    id: String(r.id),
    type: r.type as MemoryType,
    title: String(r.title),
    content: String(r.content),
    key: (r.key as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    source: r.source as MemoryEntry['source'],
    status: r.status as MemoryStatus,
    pinned: Boolean(r.pinned),
    useCount: Number(r.use_count ?? 0),
    createdAt: (r.created_at as Date)?.toISOString?.() ?? String(r.created_at),
    updatedAt: (r.updated_at as Date)?.toISOString?.() ?? String(r.updated_at),
  };
}

/** Save something. Structured keys replace the previous value rather than duplicating. */
export async function remember(args: RememberArgs): Promise<MemoryEntry | null> {
  const entry = {
    type: args.type,
    title: args.title.trim().slice(0, 200),
    content: args.content.trim().slice(0, 2000),
    key: args.key ?? null,
    subject: args.subject?.toLowerCase() ?? null,
    importance: Math.min(5, Math.max(1, args.importance ?? 3)),
    confidence: Math.min(1, Math.max(0, args.confidence ?? 1)),
    source: args.source ?? 'explicit',
    status: args.status ?? 'active',
  };

  if (!hasDb()) {
    const created: MemoryEntry = {
      id: `mem_${nextId++}`,
      ...entry,
      pinned: false,
      useCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (entry.key) {
      const idx = memory.findIndex((m) => m.key === entry.key && m.status === 'active');
      if (idx >= 0) memory.splice(idx, 1);
    }
    memory.push(created);
    return created;
  }

  try {
    const db = requireDb();

    // A structured preference has one current value; supersede the old one.
    if (entry.key && entry.status === 'active') {
      await db`
        update memory_entries set status = 'archived'
        where user_id = ${args.userId} and key = ${entry.key} and status = 'active'
      `;
    }

    const rows = await db`
      insert into memory_entries
        (user_id, type, title, content, key, subject, importance, confidence, source, source_ref, status)
      values (
        ${args.userId}, ${entry.type}, ${entry.title}, ${entry.content}, ${entry.key},
        ${entry.subject}, ${entry.importance}, ${entry.confidence}, ${entry.source},
        ${args.sourceRef ?? null}, ${entry.status}
      )
      returning *
    `;

    const created = rows[0];
    if (!created) return null;
    logger.info({ userId: args.userId, type: entry.type, title: entry.title }, 'Memory saved');
    return rowToEntry(created);
  } catch (err) {
    logger.error({ err }, 'Could not save memory');
    return null;
  }
}

export interface RecallOptions {
  types?: MemoryType[];
  subject?: string;
  query?: string;
  limit?: number;
  includeProposed?: boolean;
}

/**
 * Retrieve what is relevant.
 *
 * Ranking blends importance, pinning, recency of use, and keyword overlap —
 * not similarity alone. A high-importance standing rule should outrank a
 * loosely-matching note every time.
 */
export async function recall(userId: string, options: RecallOptions = {}): Promise<MemoryEntry[]> {
  const { types, subject, query, limit = 12, includeProposed = false } = options;
  const statuses = includeProposed ? ['active', 'proposed'] : ['active'];

  if (!hasDb()) {
    return memory
      .filter((m) => statuses.includes(m.status))
      .filter((m) => !types || types.includes(m.type))
      .filter((m) => !subject || m.subject === subject.toLowerCase())
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance)
      .slice(0, limit);
  }

  try {
    const db = requireDb();
    const terms = (query ?? '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 8);

    const tsQuery = terms.length ? terms.join(' | ') : null;

    const rows = await db`
      select *,
        (importance * 2)
        + (case when pinned then 6 else 0 end)
        + (case when ${subject ?? null}::text is not null and lower(subject) = ${subject?.toLowerCase() ?? null} then 8 else 0 end)
        + (case when ${tsQuery}::text is not null
                 then ts_rank(to_tsvector('english', title || ' ' || content), to_tsquery('english', ${tsQuery})) * 12
                 else 0 end)
        + (case when last_used_at > now() - interval '7 days' then 2 else 0 end)
        as score
      from memory_entries
      where user_id = ${userId}
        and status = any(${statuses})
        and (expires_at is null or expires_at > now())
        ${types && types.length ? db`and type = any(${types})` : db``}
      order by score desc, importance desc, updated_at desc
      limit ${limit}
    `;

    return rows.map(rowToEntry);
  } catch (err) {
    logger.error({ err }, 'Could not recall memory');
    return [];
  }
}

export async function markUsed(ids: string[]): Promise<void> {
  if (!hasDb() || ids.length === 0) return;
  try {
    const db = requireDb();
    await db`
      update memory_entries
      set use_count = use_count + 1, last_used_at = now()
      where id = any(${ids}::uuid[])
    `;
  } catch {
    // Bookkeeping only; never worth failing a request over.
  }
}

export async function listMemory(userId: string, status?: MemoryStatus): Promise<MemoryEntry[]> {
  if (!hasDb()) return memory.filter((m) => !status || m.status === status);

  const db = requireDb();
  const rows = status
    ? await db`select * from memory_entries where user_id = ${userId} and status = ${status} order by updated_at desc limit 200`
    : await db`select * from memory_entries where user_id = ${userId} and status != 'archived' order by pinned desc, updated_at desc limit 200`;
  return rows.map(rowToEntry);
}

export async function updateMemory(
  userId: string,
  id: string,
  patch: { title?: string; content?: string; importance?: number; pinned?: boolean; status?: MemoryStatus },
): Promise<void> {
  if (!hasDb()) {
    const entry = memory.find((m) => m.id === id);
    if (entry) Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    return;
  }

  const db = requireDb();
  await db`
    update memory_entries set
      title      = coalesce(${patch.title ?? null}, title),
      content    = coalesce(${patch.content ?? null}, content),
      importance = coalesce(${patch.importance ?? null}, importance),
      pinned     = coalesce(${patch.pinned ?? null}, pinned),
      status     = coalesce(${patch.status ?? null}, status)
    where id = ${id} and user_id = ${userId}
  `;
}

export async function forget(userId: string, id: string): Promise<void> {
  if (!hasDb()) {
    const idx = memory.findIndex((m) => m.id === id);
    if (idx >= 0) memory.splice(idx, 1);
    return;
  }
  const db = requireDb();
  await db`delete from memory_entries where id = ${id} and user_id = ${userId}`;
}

/** Structured preferences as a plain object, for engines that consume them. */
export async function preferenceMap(userId: string): Promise<Record<string, string>> {
  const entries = await recall(userId, { types: ['preference'], limit: 50 });
  const out: Record<string, string> = {};
  for (const e of entries) if (e.key) out[e.key] = e.content;
  return out;
}
