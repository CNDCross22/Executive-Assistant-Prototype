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
export type MemoryScope = 'global' | 'person' | 'project' | 'communication' | 'calendar' | 'email' | 'operational';
export type MemoryConflictState = 'none' | 'review';

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
  sourceRef: string | null;
  status: MemoryStatus;
  scope: MemoryScope;
  scopeRef: string | null;
  conflictState: MemoryConflictState;
  supersedesId: string | null;
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  lastConfirmedAt: string | null;
  expiresAt: string | null;
  isExpired: boolean;
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
  scope?: MemoryScope;
  scopeRef?: string | null;
  expiresAt?: string | null;
  lastConfirmedAt?: string | null;
}

// --- in-memory fallback so the app still works before the database exists ---
export class ScopedMemoryFallback {
  private readonly byUser = new Map<string, MemoryEntry[]>();

  forUser(userId: string): MemoryEntry[] {
    const current = this.byUser.get(userId);
    if (current) return current;
    const created: MemoryEntry[] = [];
    this.byUser.set(userId, created);
    return created;
  }

  clear(): void {
    this.byUser.clear();
  }
}

const memoryFallback = new ScopedMemoryFallback();
let nextId = 1;

function fallbackFor(userId: string): MemoryEntry[] {
  return memoryFallback.forUser(userId);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return (value as Date)?.toISOString?.() ?? String(value);
}

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
    sourceRef: (r.source_ref as string | null) ?? null,
    status: r.status as MemoryStatus,
    scope: (r.scope as MemoryScope | null) ?? 'global',
    scopeRef: (r.scope_ref as string | null) ?? null,
    conflictState: (r.conflict_state as MemoryConflictState | null) ?? 'none',
    supersedesId: (r.supersedes_id as string | null) ?? null,
    pinned: Boolean(r.pinned),
    useCount: Number(r.use_count ?? 0),
    lastUsedAt: iso(r.last_used_at),
    lastConfirmedAt: iso(r.last_confirmed_at),
    expiresAt: iso(r.expires_at),
    isExpired: Boolean(r.expires_at && Date.parse(iso(r.expires_at) ?? '') <= Date.now()),
    createdAt: (r.created_at as Date)?.toISOString?.() ?? String(r.created_at),
    updatedAt: (r.updated_at as Date)?.toISOString?.() ?? String(r.updated_at),
  };
}

export interface MemoryScopeContext {
  scopes: MemoryScope[];
  references: string[];
}

export function inferMemoryScopeContext(message: string): MemoryScopeContext {
  const text = message.toLowerCase();
  const scopes = new Set<MemoryScope>(['global', 'operational']);
  if (/\b(email|mail|reply|forward|subject|recipient|cc|bcc|message|draft)\b/.test(text)) {
    scopes.add('email');
    scopes.add('communication');
  }
  if (/\b(calendar|meeting|schedule|book|appointment|invite|attendee|time|timezone)\b/.test(text)) scopes.add('calendar');
  if (/\b(project|programme|program|initiative|delivery|milestone)\b/.test(text)) scopes.add('project');
  const references = [
    ...(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []),
    ...text.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((word) => word.length >= 4),
  ].slice(0, 30);
  return { scopes: [...scopes], references };
}

export function memorySpecificity(entry: Pick<MemoryEntry, 'scope' | 'scopeRef'>): number {
  if (entry.scope === 'person' || entry.scope === 'project') return entry.scopeRef ? 4 : 3;
  if (entry.scope === 'email' || entry.scope === 'calendar' || entry.scope === 'communication') return entry.scopeRef ? 3 : 2;
  if (entry.scope === 'operational') return 1;
  return 0;
}

export interface MemoryConflict {
  firstId: string;
  secondId: string;
  reason: 'opposing_rules';
}

function memoryTerms(value: string): Set<string> {
  const ignored = new Set(['always', 'never', 'not', 'dont', 'prefer', 'must', 'should', 'avoid', 'director', 'please', 'anything']);
  return new Set(value.toLowerCase().replace(/don't/g, 'dont').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !ignored.has(word)));
}

function polarity(value: string): -1 | 0 | 1 {
  if (/\b(never|do not|don't|avoid|no )\b/i.test(value)) return -1;
  if (/\b(always|prefer|must|keep|use|provide)\b/i.test(value)) return 1;
  return 0;
}

export function findMemoryConflicts(entries: MemoryEntry[]): MemoryConflict[] {
  const active = entries.filter((entry) => entry.status === 'active' && !entry.isExpired);
  const conflicts: MemoryConflict[] = [];
  for (let left = 0; left < active.length; left++) {
    for (let right = left + 1; right < active.length; right++) {
      const first = active[left]!;
      const second = active[right]!;
      if (first.scope !== second.scope || first.scopeRef !== second.scopeRef) continue;
      const firstPolarity = polarity(first.content);
      const secondPolarity = polarity(second.content);
      if (!firstPolarity || !secondPolarity || firstPolarity === secondPolarity) continue;
      const a = memoryTerms(first.content);
      const b = memoryTerms(second.content);
      const shared = [...a].filter((word) => b.has(word)).length;
      const denominator = Math.max(1, Math.min(a.size, b.size));
      if (shared / denominator >= 0.5) conflicts.push({ firstId: first.id, secondId: second.id, reason: 'opposing_rules' });
    }
  }
  return conflicts;
}

function scopeApplies(entry: MemoryEntry, context?: MemoryScopeContext): boolean {
  if (entry.scope === 'global' || entry.scope === 'operational') return true;
  if (!context?.scopes.includes(entry.scope)) return false;
  if (!entry.scopeRef) return true;
  const target = entry.scopeRef.toLowerCase();
  return context.references.some((reference) => reference === target || target.includes(reference) || reference.includes(target));
}

/** Specific approved rules win without deleting broader rules. */
export function selectApplicableMemories(entries: MemoryEntry[], context?: MemoryScopeContext, limit = 12): MemoryEntry[] {
  const conflicts = findMemoryConflicts(entries);
  const conflicted = new Set(conflicts.flatMap((conflict) => [conflict.firstId, conflict.secondId]));
  const usable = entries.filter((entry) => entry.status === 'active' && !entry.isExpired && entry.conflictState !== 'review' && !conflicted.has(entry.id) && scopeApplies(entry, context));
  const bestByKey = new Map<string, MemoryEntry>();
  const unkeyed: MemoryEntry[] = [];
  for (const entry of usable) {
    if (!entry.key) {
      unkeyed.push(entry);
      continue;
    }
    const current = bestByKey.get(entry.key);
    const rank = (candidate: MemoryEntry) => [
      memorySpecificity(candidate),
      candidate.source === 'explicit' ? 2 : candidate.source === 'observed' ? 1 : 0,
      candidate.confidence,
      candidate.importance,
      Date.parse(candidate.lastConfirmedAt ?? candidate.updatedAt),
    ];
    if (!current || rank(entry).some((value, index) => value > rank(current)[index]! && rank(entry).slice(0, index).every((prior, priorIndex) => prior === rank(current)[priorIndex]))) {
      bestByKey.set(entry.key, entry);
    }
  }
  return [...bestByKey.values(), ...unkeyed]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || memorySpecificity(b) - memorySpecificity(a) || b.importance - a.importance || b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * A short label for an entry saved without one.
 *
 * Titles are used for conflict detection and for reading back what was saved,
 * but the preferences list shows the rule itself, so a caller who has only the
 * rule should not have to invent a name for it. The first sentence is almost
 * always the right label; a long one is cut at a word.
 */
export function titleFor(content: string): string {
  const firstSentence = content.trim().split(/(?<=[.!?])\s+/)[0] ?? content.trim();
  const cleaned = firstSentence.replace(/\s+/g, ' ').replace(/[.]+$/, '').trim();
  if (cleaned.length <= 80) return cleaned || content.trim().slice(0, 80);
  return `${cleaned.slice(0, 80).replace(/\s+\S*$/, '')}…`;
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
    scope: args.scope ?? (args.type === 'person' ? 'person' : args.type === 'operational' ? 'operational' : 'global'),
    scopeRef: args.scopeRef?.trim().toLowerCase() ?? args.subject?.trim().toLowerCase() ?? null,
    expiresAt: args.expiresAt ?? null,
    lastConfirmedAt: args.lastConfirmedAt ?? (args.status === 'proposed' ? null : new Date().toISOString()),
  };

  if (!hasDb()) {
    const memory = fallbackFor(args.userId);
    const duplicate = memory.find((m) =>
      m.status === 'active' &&
      m.scope === entry.scope &&
      m.scopeRef === entry.scopeRef &&
      (m.title.toLowerCase() === entry.title.toLowerCase() || m.content.toLowerCase() === entry.content.toLowerCase())
    );
    if (duplicate) return duplicate;
    const created: MemoryEntry = {
      id: `mem_${nextId++}`,
      ...entry,
      sourceRef: args.sourceRef ?? null,
      conflictState: 'none' as const,
      supersedesId: null,
      pinned: false,
      useCount: 0,
      lastUsedAt: null,
      isExpired: Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (entry.key) {
      const previous = memory.find((m) => m.key === entry.key && m.scope === entry.scope && m.scopeRef === entry.scopeRef && m.status === 'active');
      if (previous) {
        previous.status = 'archived';
        created.supersedesId = previous.id;
      }
    }
    memory.push(created);
    return created;
  }

  try {
    const db = requireDb();

    const duplicates = await db`
      select * from memory_entries
      where user_id = ${args.userId}
        and status = 'active'
        and scope = ${entry.scope}
        and coalesce(scope_ref, '') = coalesce(${entry.scopeRef}, '')
        and (lower(title) = lower(${entry.title}) or lower(content) = lower(${entry.content}))
      order by updated_at desc
      limit 1
    `;
    if (duplicates[0]) return rowToEntry(duplicates[0]);

    // Supersede only the same key at the same specificity. A more specific
    // legal/person/project rule must coexist with the broader rule.
    let supersedesId: string | null = null;
    if (entry.key && entry.status === 'active') {
      const previous = await db<{ id: string }[]>`
        select id from memory_entries
        where user_id = ${args.userId} and key = ${entry.key} and scope = ${entry.scope}
          and coalesce(scope_ref, '') = coalesce(${entry.scopeRef}, '') and status = 'active'
        order by updated_at desc limit 1
      `;
      supersedesId = previous[0]?.id ?? null;
      await db`
        update memory_entries set status = 'archived'
        where user_id = ${args.userId} and key = ${entry.key} and scope = ${entry.scope}
          and coalesce(scope_ref, '') = coalesce(${entry.scopeRef}, '') and status = 'active'
      `;
    }

    const rows = await db`
      insert into memory_entries
        (user_id, type, title, content, key, subject, importance, confidence, source, source_ref, status,
         scope, scope_ref, expires_at, last_confirmed_at, supersedes_id)
      values (
        ${args.userId}, ${entry.type}, ${entry.title}, ${entry.content}, ${entry.key},
        ${entry.subject}, ${entry.importance}, ${entry.confidence}, ${entry.source},
        ${args.sourceRef ?? null}, ${entry.status}, ${entry.scope}, ${entry.scopeRef}, ${entry.expiresAt},
        ${entry.lastConfirmedAt}, ${supersedesId}
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
  scopeContext?: MemoryScopeContext;
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
  const scopeContext = options.scopeContext ?? (subject
    ? { scopes: ['global', 'operational', 'person'] as MemoryScope[], references: [subject.toLowerCase()] }
    : inferMemoryScopeContext(query ?? ''));

  if (!hasDb()) {
    const candidates = fallbackFor(userId)
      .filter((m) => statuses.includes(m.status))
      .filter((m) => !types || types.includes(m.type))
      .filter((m) => !subject || m.subject === subject.toLowerCase())
      .map((m) => ({ ...m, isExpired: Boolean(m.expiresAt && Date.parse(m.expiresAt) <= Date.now()) }));
    return includeProposed
      ? candidates.filter((entry) => scopeApplies(entry, scopeContext)).slice(0, limit)
      : selectApplicableMemories(candidates, scopeContext, limit);
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
    const scopes = scopeContext.scopes;
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
        and (
          scope in ('global', 'operational')
          or scope = any(${scopes})
        )
        ${types && types.length ? db`and type = any(${types})` : db``}
      order by score desc, importance desc, updated_at desc
      limit 100
    `;

    const entries = rows.map(rowToEntry);
    return includeProposed ? entries.slice(0, limit) : selectApplicableMemories(entries, scopeContext, limit);
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
  if (!hasDb()) return fallbackFor(userId).filter((m) => !status || m.status === status).map((m) => ({
    ...m,
    isExpired: Boolean(m.expiresAt && Date.parse(m.expiresAt) <= Date.now()),
  }));

  const db = requireDb();
  const rows = status
    ? await db`select * from memory_entries where user_id = ${userId} and status = ${status} order by updated_at desc limit 200`
    : await db`select * from memory_entries where user_id = ${userId} and status != 'archived' order by pinned desc, updated_at desc limit 200`;
  return rows.map(rowToEntry);
}

/** Fetch one exact memory owned by this Director. */
export async function getMemory(userId: string, id: string): Promise<MemoryEntry | null> {
  if (!hasDb()) return fallbackFor(userId).find((entry) => entry.id === id) ?? null;

  try {
    const db = requireDb();
    const rows = await db`
      select * from memory_entries
      where id = ${id} and user_id = ${userId} and status != 'archived'
      limit 1
    `;
    return rows[0] ? rowToEntry(rows[0]) : null;
  } catch (err) {
    logger.error({ err }, 'Could not read memory');
    return null;
  }
}

export async function updateMemory(
  userId: string,
  id: string,
  patch: {
    title?: string;
    content?: string;
    importance?: number;
    pinned?: boolean;
    status?: MemoryStatus;
    scope?: MemoryScope;
    scopeRef?: string | null;
    expiresAt?: string | null;
    conflictState?: MemoryConflictState;
  },
): Promise<void> {
  if (!hasDb()) {
    const entry = fallbackFor(userId).find((m) => m.id === id);
    if (entry) Object.assign(entry, patch, {
      ...(patch.status === 'active' ? { lastConfirmedAt: new Date().toISOString() } : {}),
      isExpired: Boolean((patch.expiresAt ?? entry.expiresAt) && Date.parse(patch.expiresAt ?? entry.expiresAt ?? '') <= Date.now()),
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const db = requireDb();
  await db`
    update memory_entries set
      title      = coalesce(${patch.title ?? null}, title),
      content    = coalesce(${patch.content ?? null}, content),
      importance = coalesce(${patch.importance ?? null}, importance),
      pinned     = coalesce(${patch.pinned ?? null}, pinned),
      status     = coalesce(${patch.status ?? null}, status),
      scope      = coalesce(${patch.scope ?? null}, scope),
      scope_ref  = case when ${patch.scopeRef === undefined} then scope_ref else ${patch.scopeRef ?? null} end,
      expires_at = case when ${patch.expiresAt === undefined} then expires_at else ${patch.expiresAt ?? null}::timestamptz end,
      conflict_state = coalesce(${patch.conflictState ?? null}, conflict_state),
      last_confirmed_at = case when ${patch.status ?? null} = 'active' then now() else last_confirmed_at end
    where id = ${id} and user_id = ${userId}
  `;
}

/** Activate an approved proposal while preserving a supersession trail. */
export async function approveMemory(userId: string, id: string): Promise<boolean> {
  if (!hasDb()) {
    const memory = fallbackFor(userId);
    const entry = memory.find((candidate) => candidate.id === id && candidate.status === 'proposed');
    if (!entry) return false;
    if (entry.key) {
      const previous = memory.find((candidate) =>
        candidate.id !== id && candidate.status === 'active' && candidate.key === entry.key &&
        candidate.scope === entry.scope && candidate.scopeRef === entry.scopeRef,
      );
      if (previous) {
        previous.status = 'archived';
        entry.supersedesId = previous.id;
      }
    }
    entry.status = 'active';
    entry.lastConfirmedAt = new Date().toISOString();
    entry.updatedAt = new Date().toISOString();
    return true;
  }

  const db = requireDb();
  const rows = await db<{ id: string; key: string | null; scope: MemoryScope; scope_ref: string | null }[]>`
    select id, key, scope, scope_ref from memory_entries
    where id = ${id} and user_id = ${userId} and status = 'proposed'
    limit 1
  `;
  const entry = rows[0];
  if (!entry) return false;
  let supersedesId: string | null = null;
  if (entry.key) {
    const previous = await db<{ id: string }[]>`
      update memory_entries set status = 'archived'
      where user_id = ${userId} and id != ${id} and key = ${entry.key} and scope = ${entry.scope}
        and coalesce(scope_ref, '') = coalesce(${entry.scope_ref}, '') and status = 'active'
      returning id
    `;
    supersedesId = previous[0]?.id ?? null;
  }
  await db`
    update memory_entries set status = 'active', last_confirmed_at = now(), supersedes_id = ${supersedesId}
    where id = ${id} and user_id = ${userId} and status = 'proposed'
  `;
  return true;
}

export async function forget(userId: string, id: string): Promise<void> {
  if (!hasDb()) {
    const memory = fallbackFor(userId);
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
