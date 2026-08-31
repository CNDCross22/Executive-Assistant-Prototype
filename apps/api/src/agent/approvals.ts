import { randomUUID } from 'node:crypto';
import { hasDb, requireDb } from '../db/index.js';
import type { ActionPreview, RiskLevel } from './tools/types.js';

export type ApprovalStatus = 'pending' | 'executing' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface ApprovalPayload {
  toolArgs: unknown;
  refs: Record<string, string>;
}

/** Accept approvals written by the first preview implementation as well as the current envelope. */
export function normaliseApprovalPayload(value: unknown): ApprovalPayload {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { toolArgs: {}, refs: {} };
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { toolArgs: {}, refs: {} };
  }

  const record = candidate as Record<string, unknown>;
  if ('toolArgs' in record) {
    const refs = record.refs && typeof record.refs === 'object' && !Array.isArray(record.refs)
      ? record.refs as Record<string, string>
      : {};
    return { toolArgs: record.toolArgs, refs };
  }

  // Legacy rows stored the validated tool arguments directly in `arguments`.
  return { toolArgs: record, refs: {} };
}

export interface PendingApproval {
  id: string;
  userId: string;
  conversationId?: string;
  tool: string;
  payload: ApprovalPayload;
  preview: ActionPreview;
  riskLevel: RiskLevel;
  expiresAt: string;
  status: ApprovalStatus;
}

const memory = new Map<string, PendingApproval>();
const TTL_MS = 15 * 60 * 1000;

export function requiresApproval(riskLevel: RiskLevel): boolean {
  return riskLevel > 0;
}

export type ApprovalDecision = 'approve' | 'reject' | null;

/** Ordinary conversation must never accidentally approve a change. */
export function parseApprovalDecision(message: string): ApprovalDecision {
  const value = message.trim().replace(/[.!]+$/, '').trim().toLowerCase();
  if (/^(yes|yes please|yes,? proceed|proceed|confirm|go ahead)$/.test(value)) return 'approve';
  if (/^(no|no thanks|cancel|do not proceed|don't proceed)$/.test(value)) return 'reject';
  return null;
}

export async function createApproval(input: {
  userId: string;
  conversationId?: string;
  tool: string;
  payload: ApprovalPayload;
  preview: ActionPreview;
  riskLevel: RiskLevel;
}): Promise<PendingApproval> {
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

  if (!hasDb()) {
    for (const approval of memory.values()) {
      if (approval.userId === input.userId && approval.conversationId === input.conversationId && approval.status === 'pending') {
        approval.status = 'expired';
      }
    }
    const approval: PendingApproval = { id: randomUUID(), ...input, expiresAt, status: 'pending' };
    memory.set(approval.id, approval);
    return approval;
  }

  const db = requireDb();
  await db`
    update action_approvals set status = 'expired'
    where user_id = ${input.userId}
      and conversation_id is not distinct from ${input.conversationId ?? null}
      and status = 'pending'
  `;
  const rows = await db<{ id: string; expires_at: Date }[]>`
    insert into action_approvals
      (user_id, conversation_id, tool_name, arguments, preview, risk_level, expires_at)
    values (
      ${input.userId}, ${input.conversationId ?? null}, ${input.tool},
      ${JSON.stringify(input.payload)}::jsonb, ${JSON.stringify(input.preview)}::jsonb,
      ${input.riskLevel}, ${expiresAt}
    ) returning id, expires_at
  `;
  return { id: rows[0]!.id, ...input, expiresAt: rows[0]!.expires_at.toISOString(), status: 'pending' };
}

function fromRow(row: {
  id: string; user_id: string; conversation_id: string | null; tool_name: string;
  arguments: unknown; preview: ActionPreview; risk_level: RiskLevel;
  expires_at: Date; status: ApprovalStatus;
}): PendingApproval {
  return {
    id: row.id, userId: row.user_id, conversationId: row.conversation_id ?? undefined,
    tool: row.tool_name, payload: normaliseApprovalPayload(row.arguments), preview: row.preview,
    riskLevel: row.risk_level, expiresAt: row.expires_at.toISOString(), status: row.status,
  };
}

export async function pendingApproval(userId: string, conversationId?: string): Promise<PendingApproval | null> {
  if (!hasDb()) {
    const found = [...memory.values()]
      .filter((a) => a.userId === userId && a.conversationId === conversationId && a.status === 'pending')
      .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
    if (!found) return null;
    if (new Date(found.expiresAt).getTime() <= Date.now()) {
      found.status = 'expired';
      return null;
    }
    return found;
  }

  const db = requireDb();
  await db`update action_approvals set status = 'expired' where user_id = ${userId} and status = 'pending' and expires_at <= now()`;
  const rows = await db<{
    id: string; user_id: string; conversation_id: string | null; tool_name: string;
    arguments: unknown; preview: ActionPreview; risk_level: RiskLevel;
    expires_at: Date; status: ApprovalStatus;
  }[]>`
    select id, user_id, conversation_id, tool_name, arguments, preview, risk_level, expires_at, status
    from action_approvals
    where user_id = ${userId}
      and conversation_id is not distinct from ${conversationId ?? null}
      and status = 'pending' and expires_at > now()
    order by created_at desc limit 1
  `;
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Atomically reserves an action, preventing double-click execution. */
export async function claimApproval(id: string, userId: string): Promise<PendingApproval | null> {
  if (!hasDb()) {
    const approval = memory.get(id);
    if (!approval || approval.userId !== userId || approval.status !== 'pending' || new Date(approval.expiresAt).getTime() <= Date.now()) return null;
    approval.status = 'executing';
    return approval;
  }
  const db = requireDb();
  const rows = await db<{
    id: string; user_id: string; conversation_id: string | null; tool_name: string;
    arguments: unknown; preview: ActionPreview; risk_level: RiskLevel;
    expires_at: Date; status: ApprovalStatus;
  }[]>`
    update action_approvals set status = 'executing', decided_at = now()
    where id = ${id} and user_id = ${userId} and status = 'pending' and expires_at > now()
    returning id, user_id, conversation_id, tool_name, arguments, preview, risk_level, expires_at, status
  `;
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function finishApproval(id: string, status: 'executed' | 'failed' | 'rejected', summary?: string): Promise<void> {
  const approval = memory.get(id);
  if (approval) approval.status = status;
  if (!hasDb()) return;
  const db = requireDb();
  await db`
    update action_approvals
    set status = ${status}, decided_at = coalesce(decided_at, now()), result_summary = ${summary ?? null}
    where id = ${id}
  `;
}
