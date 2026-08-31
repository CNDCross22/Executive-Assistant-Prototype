import { hasDb, requireDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { ModelRole, BudgetCategory } from '../ai/policy.js';
import type { ResponseMode } from '../agent/response-policy.js';
import type { RiskLevel } from '../agent/tools/types.js';

export type TelemetryCategory = 'request' | 'model' | 'tool' | 'approval' | 'memory' | 'context' | 'security' | 'briefing' | 'proactive';
export type TelemetryStatus = 'pending' | 'success' | 'failed' | 'cancelled' | 'awaiting_approval';
export type TelemetryAction =
  | 'assistant_turn'
  | 'call'
  | 'approval_created'
  | 'approval_execution'
  | 'cancelled'
  | 'superseded'
  | 'retrieved'
  | 'proposed'
  | 'false_action_blocked'
  | 'untrusted_content_warning'
  | 'generated'
  | 'assembled';

export interface TelemetryEvent {
  category: TelemetryCategory;
  action: TelemetryAction;
  status: TelemetryStatus;
  userId?: string;
  requestId?: string;
  conversationId?: string;
  workflowId?: string;
  model?: string;
  modelRole?: ModelRole;
  responseMode?: ResponseMode;
  budgetCategory?: BudgetCategory;
  purpose?: string;
  tool?: string;
  riskLevel?: RiskLevel;
  durationMs?: number;
  iteration?: number;
  iterations?: number;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  costMicros?: number;
  count?: number;
  candidateMessages?: number;
  selectedMessages?: number;
  estimatedTokens?: number;
  reasonCode?: string;
}

const DETAIL_KEYS = [
  'conversationId', 'workflowId', 'model', 'modelRole', 'responseMode', 'budgetCategory',
  'purpose', 'tool', 'durationMs', 'iteration', 'iterations', 'promptTokens', 'cachedTokens',
  'completionTokens', 'costMicros', 'count', 'candidateMessages', 'selectedMessages',
  'estimatedTokens', 'reasonCode',
] as const;
const CATEGORIES = new Set<TelemetryCategory>(['request', 'model', 'tool', 'approval', 'memory', 'context', 'security', 'briefing', 'proactive']);
const STATUSES = new Set<TelemetryStatus>(['pending', 'success', 'failed', 'cancelled', 'awaiting_approval']);
const ACTIONS = new Set<TelemetryAction>([
  'assistant_turn', 'call', 'approval_created', 'approval_execution', 'cancelled', 'superseded',
  'retrieved', 'proposed', 'false_action_blocked', 'untrusted_content_warning', 'generated', 'assembled',
]);

/** Runtime allowlist. Arbitrary objects can never smuggle content or secrets into telemetry. */
export function safeTelemetryPayload(event: TelemetryEvent | Record<string, unknown>): Record<string, unknown> {
  const source = event as Record<string, unknown>;
  const category = CATEGORIES.has(source.category as TelemetryCategory) ? source.category : 'security';
  const action = ACTIONS.has(source.action as TelemetryAction) ? source.action : 'call';
  const status = STATUSES.has(source.status as TelemetryStatus) ? source.status : 'failed';
  const safe: Record<string, unknown> = {
    category,
    action,
    status,
  };
  const safeLabel = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.length <= max && /^[a-z0-9_.:@/-]+$/i.test(value) ? value : undefined;

  const requestId = safeLabel(source.requestId, 128);
  const userId = safeLabel(source.userId, 128);
  if (requestId) safe.requestId = requestId;
  if (userId) safe.userId = userId;
  if (typeof source.riskLevel === 'number') safe.riskLevel = source.riskLevel;
  for (const key of DETAIL_KEYS) {
    const value = source[key];
    if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
    if (typeof value === 'string') {
      const label = safeLabel(value, key === 'model' ? 128 : 96);
      if (label) safe[key] = label;
    }
  }
  return safe;
}

export async function recordTelemetry(event: TelemetryEvent): Promise<void> {
  const safe = safeTelemetryPayload(event);
  logger.info({ telemetry: safe }, 'Hermes telemetry');
  if (!hasDb()) return;

  const detail = { ...safe };
  delete detail.userId;
  delete detail.requestId;
  delete detail.category;
  delete detail.action;
  delete detail.status;
  delete detail.riskLevel;

  try {
    const db = requireDb();
    const category = String(safe.category);
    const action = String(safe.action);
    const status = String(safe.status);
    const userId = typeof safe.userId === 'string' ? safe.userId : null;
    const requestId = typeof safe.requestId === 'string' ? safe.requestId : null;
    const riskLevel = typeof safe.riskLevel === 'number' ? safe.riskLevel : 0;
    const tool = typeof safe.tool === 'string' ? safe.tool : null;
    const model = typeof safe.model === 'string' ? safe.model : null;
    const workflowId = typeof safe.workflowId === 'string' ? safe.workflowId : null;
    const durationMs = typeof safe.durationMs === 'number' ? safe.durationMs : null;
    await db`
      insert into audit_events
        (user_id, request_id, category, action, resource_type, resource_id, status, risk_level, detail, duration_ms)
      values (
        ${userId}, ${requestId}, ${category}, ${action},
        ${tool ? 'tool' : model ? 'model' : 'workflow'}, ${tool ?? model ?? workflowId},
        ${status}, ${riskLevel}, ${JSON.stringify(detail)}::jsonb, ${durationMs}
      )
    `;
  } catch (err) {
    // Observability must never turn a successful Director request into a failure.
    logger.error({ err, category: event.category, action: event.action }, 'Could not persist telemetry');
  }
}
