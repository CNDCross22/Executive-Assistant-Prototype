import type { ActionPreview, RiskLevel, Tool, ToolContext } from './tools/types.js';
import type { ToolDefinition } from '../ai/provider.js';
import { mailTools } from './tools/mail.tools.js';
import { memoryTools } from './tools/memory.tools.js';
import { officeTools } from './tools/office.tools.js';
import { expansionTools } from './tools/expansion.tools.js';
import { isCapabilityEnabled } from '../config/graphScopes.js';
import { Errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { claimApproval, createApproval, finishApproval, requiresApproval, type PendingApproval } from './approvals.js';
import { recordTelemetry } from '../observability/telemetry.js';

const ALL: Tool<never>[] = [...mailTools, ...officeTools, ...memoryTools, ...expansionTools];

/** Only tools whose capability is switched on. */
export function availableTools(): Tool<never>[] {
  return ALL.filter((t) => isCapabilityEnabled(t.capability));
}

export function toolDefinitions(only?: string[]): ToolDefinition[] {
  const tools = availableTools();
  const filtered = only && only.length > 0 ? tools.filter((t) => only.includes(t.name)) : tools;
  // Never leave the model with nothing to call.
  const chosen = filtered.length > 0 ? filtered : tools;

  return chosen.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function findTool(name: string): Tool<never> | undefined {
  return availableTools().find((t) => t.name === name);
}

export interface ToolOutcome {
  name: string;
  summary: string;
  status: 'success' | 'failed' | 'approval_required';
  result: unknown;
  durationMs: number;
  riskLevel: RiskLevel;
  approval?: PendingApproval;
}

function reportToolOutcome(
  ctx: ToolContext,
  outcome: ToolOutcome,
  lifecycle: 'call' | 'approval_created' | 'approval_execution' = 'call',
): ToolOutcome {
  void recordTelemetry({
    category: lifecycle === 'call' ? 'tool' : 'approval',
    action: lifecycle,
    status: outcome.status === 'approval_required'
      ? 'awaiting_approval'
      : outcome.status === 'success' ? 'success' : 'failed',
    userId: ctx.user.id,
    requestId: ctx.requestId,
    conversationId: ctx.conversationId,
    workflowId: ctx.workflowId,
    tool: outcome.name,
    riskLevel: outcome.riskLevel,
    durationMs: outcome.durationMs,
  });
  if (containsSecurityWarning(outcome.result)) {
    void recordTelemetry({
      category: 'security', action: 'untrusted_content_warning', status: 'success',
      userId: ctx.user.id, requestId: ctx.requestId, conversationId: ctx.conversationId,
      workflowId: ctx.workflowId, tool: outcome.name, riskLevel: outcome.riskLevel,
    });
  }
  return outcome;
}

function containsSecurityWarning(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 3) return false;
  if (Array.isArray(value)) return value.some((item) => containsSecurityWarning(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (typeof record.SECURITY_WARNING === 'string') return true;
  return Object.values(record).some((item) => containsSecurityWarning(item, depth + 1));
}

/**
 * Execute one model-requested tool call.
 *
 * The model never touches Microsoft Graph directly. It proposes a name and
 * arguments; we validate them against the tool's schema and refuse anything
 * that does not fit.
 */
export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const started = Date.now();
  const tool = findTool(name);

  if (!tool) {
    return reportToolOutcome(ctx, {
      name,
      summary: `Unknown tool: ${name}`,
      status: 'failed',
      result: { error: `There is no tool called "${name}".` },
      durationMs: 0,
      riskLevel: 0,
    });
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return reportToolOutcome(ctx, {
      name,
      summary: `${name}: arguments were not valid JSON`,
      status: 'failed',
      result: { error: 'Arguments were not valid JSON. Try again with a valid object.' },
      durationMs: Date.now() - started,
      riskLevel: tool.riskLevel,
    });
  }

  const validated = tool.schema.safeParse(parsedArgs);
  if (!validated.success) {
    const detail = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return reportToolOutcome(ctx, {
      name,
      summary: `${name}: arguments rejected`,
      status: 'failed',
      result: { error: `Those arguments are not valid. ${detail}` },
      durationMs: Date.now() - started,
      riskLevel: tool.riskLevel,
    });
  }

  const args = validated.data as never;

  // Anything above read-only must go through the approval engine. A tool
  // without a safe preview is refused rather than silently executed.
  if (requiresApproval(tool.riskLevel)) {
    if (!tool.preview) {
      return reportToolOutcome(ctx, {
        name,
        summary: `${tool.summarise(args)}: blocked because the preview is unavailable`,
        status: 'failed',
        result: { error: 'This action cannot run because it has no safe preview.' },
        durationMs: Date.now() - started,
        riskLevel: tool.riskLevel,
      });
    }
    let preview: ActionPreview;
    try {
      preview = await tool.preview(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The target could not be verified.';
      logger.warn({ tool: name, userId: ctx.user.id, err }, 'Could not prepare action preview');
      return reportToolOutcome(ctx, {
        name,
        summary: `${tool.summarise(args)}: target could not be verified`,
        status: 'failed',
        result: { error: `${message} Nothing was changed and no approval was created.` },
        durationMs: Date.now() - started,
        riskLevel: tool.riskLevel,
      });
    }
    const approval = await createApproval({
      userId: ctx.user.id,
      conversationId: ctx.conversationId,
      tool: tool.name,
      payload: { toolArgs: validated.data, refs: ctx.refs.snapshot() },
      preview,
      riskLevel: tool.riskLevel,
    });
    return reportToolOutcome(ctx, {
      name,
      summary: `Prepared: ${preview.summary}; waiting for confirmation`,
      status: 'approval_required',
      result: {
        approvalRequired: true,
        approvalId: approval.id,
        preview,
        question: 'Please reply Yes to proceed or No to cancel.',
      },
      durationMs: Date.now() - started,
      riskLevel: tool.riskLevel,
      approval,
    }, 'approval_created');
  }

  try {
    const result = await tool.execute(args, ctx);
    const durationMs = Date.now() - started;
    logger.info({ tool: name, durationMs, userId: ctx.user.id }, 'Tool executed');
    return reportToolOutcome(ctx, { name, summary: tool.summarise(args), status: 'success', result, durationMs, riskLevel: tool.riskLevel });
  } catch (err) {
    const durationMs = Date.now() - started;
    const message =
      err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : 'Tool failed.';
    logger.warn({ tool: name, durationMs, err }, 'Tool failed');

    // Re-throw auth failures so the whole turn stops and the UI can prompt a reconnect.
    if (err === Errors.needsReauth() || (err as { code?: string }).code === 'needs_reauth') throw err;

    return reportToolOutcome(ctx, {
      name,
      summary: `${tool.summarise(args)}: failed`,
      status: 'failed',
      result: { error: message },
      durationMs,
      riskLevel: tool.riskLevel,
    });
  }
}

/** Execute exactly the validated operation stored with a confirmed preview. */
export async function executeApprovedTool(approval: PendingApproval, ctx: ToolContext): Promise<ToolOutcome> {
  const started = Date.now();
  const claimed = await claimApproval(approval.id, ctx.user.id);
  if (!claimed || claimed.conversationId !== ctx.conversationId) {
    return reportToolOutcome(ctx, {
      name: approval.tool,
      summary: 'Confirmation expired or was already used',
      status: 'failed',
      result: { error: 'That confirmation is no longer available. Please ask me to prepare the action again.' },
      durationMs: Date.now() - started,
      riskLevel: approval.riskLevel,
    }, 'approval_execution');
  }

  const tool = findTool(claimed.tool);
  if (!tool || tool.riskLevel !== claimed.riskLevel) {
    await recordApprovalStatus(claimed.id, 'failed', 'Tool is unavailable.');
    return reportToolOutcome(ctx, { name: claimed.tool, summary: 'Approved action is unavailable', status: 'failed', result: { error: 'That action is no longer available. Nothing was changed.' }, durationMs: Date.now() - started, riskLevel: claimed.riskLevel }, 'approval_execution');
  }

  const validated = tool.schema.safeParse(claimed.payload.toolArgs);
  if (!validated.success) {
    logger.warn({
      tool: claimed.tool,
      approvalId: claimed.id,
      issuePaths: validated.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    }, 'Approved action arguments failed validation');
    await recordApprovalStatus(claimed.id, 'failed', 'Stored arguments did not validate.');
    return reportToolOutcome(ctx, { name: claimed.tool, summary: 'Approved action failed validation', status: 'failed', result: { error: 'The saved action was not valid. Nothing was changed.' }, durationMs: Date.now() - started, riskLevel: claimed.riskLevel }, 'approval_execution');
  }

  ctx.refs.restore(claimed.payload.refs);
  const args = validated.data as never;
  let result: unknown;
  try {
    result = await tool.execute(args, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The approved action failed.';
    const uncertain = Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'graph_unavailable');
    await recordApprovalStatus(claimed.id, 'failed', uncertain ? 'Microsoft did not confirm the outcome.' : message.slice(0, 500));
    logger.warn({ tool: tool.name, approvalId: claimed.id, err }, 'Approved tool failed');
    return reportToolOutcome(ctx, {
      name: tool.name,
      summary: `${tool.summarise(args)}: ${uncertain ? 'outcome not confirmed' : 'failed'}`,
      status: 'failed',
      result: uncertain
        ? { error: 'Microsoft 365 did not confirm whether the action completed. Check Outlook before trying again, to avoid doing it twice.', outcomeUncertain: true }
        : { error: message },
      durationMs: Date.now() - started,
      riskLevel: tool.riskLevel,
    }, 'approval_execution');
  }

  const summary = tool.summarise(args);
  // Graph has already confirmed success. A later audit-write failure must not
  // reverse the truth reported to the Director.
  await recordApprovalStatus(claimed.id, 'executed', summary);
  logger.info({ tool: tool.name, approvalId: claimed.id, userId: ctx.user.id }, 'Approved tool executed');
  return reportToolOutcome(ctx, { name: tool.name, summary, status: 'success', result, durationMs: Date.now() - started, riskLevel: tool.riskLevel }, 'approval_execution');
}

async function recordApprovalStatus(id: string, status: 'executed' | 'failed' | 'rejected', summary: string): Promise<void> {
  try {
    await finishApproval(id, status, summary);
  } catch (err) {
    logger.error({ approvalId: id, status, err }, 'Could not persist approval status');
  }
}
