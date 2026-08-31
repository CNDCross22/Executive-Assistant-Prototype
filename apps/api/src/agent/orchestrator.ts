import { aiProvider } from '../ai/index.js';
import { assertWithinBudget, recordUsage } from '../ai/cost.js';
import type { ChatMessage } from '../ai/provider.js';
import { systemPrompt, formatToolResult } from './prompt.js';
import { toolDefinitions, executeApprovedTool, executeTool, type ToolOutcome } from './registry.js';
import type { ToolContext } from './tools/types.js';
import { logger } from '../lib/logger.js';
import { AppError, Errors } from '../lib/errors.js';
import { tryFastPath } from './fastpath.js';
import {
  checkCapability,
  checkClaims,
  isActionRequest,
  isApprovalRevisionRequest,
  isDurableMemoryStatement,
  looksLikeApprovalPrompt,
  looksLikeInternalProcess,
} from './guards.js';
import { recall, markUsed } from '../memory/store.js';
import { observeFromMessage } from '../memory/learning.js';
import { parseExplicitMemory } from '../memory/explicit.js';
import { selectSkills, toolsForSkills } from './skills.js';
import { finishApproval, parseApprovalDecision, pendingApproval, type PendingApproval } from './approvals.js';
import type { ActionPreview } from './tools/types.js';
import { classifyResponseMode, responsePolicy } from './response-policy.js';
import { resolveModelPolicy } from '../ai/policy.js';
import { recordTelemetry } from '../observability/telemetry.js';
import { assembleContext, type ContextTurn } from './context.js';

const MAX_ITERATIONS = 6;
const TURN_TIMEOUT_MS = 180_000;

export interface AgentStep {
  tool: string;
  summary: string;
  status: 'success' | 'failed' | 'approval_required';
}

export interface AgentResult {
  reply: string;
  steps: AgentStep[];
  iterations: number;
  model: string;
  durationMs: number;
  approval?: { id: string; preview: ActionPreview; expiresAt: string };
}

export interface AgentInput {
  ctx: ToolContext;
  /** Prior turns, oldest first. Excludes the message being sent now. */
  history: ContextTurn[];
  message: string;
}

/**
 * The bounded agent loop.
 *
 * Hard stops on iteration count and wall-clock time. There is no path by which
 * this runs indefinitely, and no path by which the model reaches Microsoft
 * Graph except through a validated tool.
 */
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const { ctx, history, message } = input;
  const started = Date.now();

  // Standalone, unambiguous approval decisions are handled before the model.
  // Only they can decide the latest pending action in this conversation.
  const decision = parseApprovalDecision(message);
  if (decision) {
    const pending = await pendingApproval(ctx.user.id, ctx.conversationId);
    if (!pending) {
      const lastAssistant = [...history].reverse().find((item) => item.role === 'assistant')?.content ?? '';
      const reply = looksLikeApprovalPrompt(lastAssistant)
        ? 'That earlier confirmation was not connected to an executable action, so I did not run it. Nothing was changed. Please ask me to prepare the action again.'
        : 'There is no pending action to confirm. Nothing was changed.';
      return { reply, steps: [], iterations: 0, model: 'direct', durationMs: Date.now() - started };
    }
    if (decision === 'reject') {
      await finishApproval(pending.id, 'rejected', 'Cancelled by the Director.');
      void recordTelemetry({
        category: 'approval', action: 'cancelled', status: 'cancelled', userId: ctx.user.id,
        requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
        tool: pending.tool, riskLevel: pending.riskLevel,
      });
      return { reply: 'Cancelled. Nothing was changed.', steps: [{ tool: pending.tool, summary: 'Cancelled by the Director', status: 'success' }], iterations: 0, model: 'direct', durationMs: Date.now() - started };
    }
    const outcome = await executeApprovedTool(pending, ctx);
    const outcomeResult = outcome.result as { error?: string; outcomeUncertain?: boolean };
    return {
      reply: outcome.status === 'success'
        ? `${outcome.summary}.`
        : outcomeResult.outcomeUncertain
          ? outcomeResult.error ?? 'Microsoft 365 did not confirm the outcome. Check Outlook before trying again.'
          : `I could not complete the approved action. ${outcomeResult.error ?? 'Nothing was changed.'}`,
      steps: [{ tool: outcome.name, summary: outcome.summary, status: outcome.status }],
      iterations: 0,
      model: 'direct',
      durationMs: Date.now() - started,
    };
  }

  // Any reply other than the explicit decision abandons the old proposal.
  // This prevents a later "Yes" from executing a stale action after the
  // Director has moved on, clarified the request, or opened another tab.
  let revision: PendingApproval | null = null;
  const superseded = await pendingApproval(ctx.user.id, ctx.conversationId);
  if (superseded) {
    if (isActionRequest(message) || isApprovalRevisionRequest(message)) {
      revision = superseded;
      // The old proposal is cancelled, but its opaque references and validated
      // arguments are safe context for preparing one replacement proposal.
      ctx.refs.restore(superseded.payload.refs);
    }
    await finishApproval(superseded.id, 'rejected', 'Superseded by a later message.');
    logger.info({ approvalId: superseded.id, tool: superseded.tool }, 'Pending action superseded');
    void recordTelemetry({
      category: 'approval', action: 'superseded', status: 'cancelled', userId: ctx.user.id,
      requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
      tool: superseded.tool, riskLevel: superseded.riskLevel,
    });
  }

  // Asking for something we cannot do must never reach the model, because an
  // agreeable model says yes and then invents the outcome.
  const refused = checkCapability(message);
  if (refused) {
    logger.info({ question: message.slice(0, 60) }, 'Refused: capability not enabled');
    return refused;
  }

  // Clear preferences and standing rules do not need model interpretation.
  // Prepare the real, approval-backed memory card immediately.
  const explicitMemory = parseExplicitMemory(message);
  if (explicitMemory) {
    const outcome = await executeTool('memory_remember', JSON.stringify(explicitMemory), ctx);
    if (outcome.approval) {
      const approval = outcome.approval;
      return {
        reply: formatApprovalPreview(approval.preview),
        steps: [{ tool: outcome.name, summary: outcome.summary, status: outcome.status }],
        iterations: 0,
        model: 'direct',
        durationMs: Date.now() - started,
        approval: { id: approval.id, preview: approval.preview, expiresAt: approval.expiresAt },
      };
    }
    const error = (outcome.result as { error?: string }).error ?? 'Nothing was saved.';
    return {
      reply: 'I could not prepare that memory safely. ' + error,
      steps: [{ tool: outcome.name, summary: outcome.summary, status: outcome.status }],
      iterations: 0,
      model: 'direct',
      durationMs: Date.now() - started,
    };
  }

  // Watch for stated preferences on every turn. Pure regex, no model, so it
  // costs nothing and cannot invent something she never said.
  if (!isDurableMemoryStatement(message)) {
    const proposals = await observeFromMessage(ctx.user.id, message);
    if (proposals.length > 0) {
      void recordTelemetry({
        category: 'memory', action: 'proposed', status: 'awaiting_approval', userId: ctx.user.id,
        requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
        count: proposals.length,
      });
    }
  }

  // Common questions already have a complete deterministic answer. Sending
  // them through the model costs minutes and adds only phrasing.
  if (history.length === 0) {
    const fast = await tryFastPath(message, ctx);
    if (fast) {
      logger.info({ durationMs: fast.durationMs, question: message.slice(0, 60) }, 'Answered without the model');
      return fast;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, ctx.signal]);

  // What she has told us, retrieved before the prompt is assembled.
  const memories = await recall(ctx.user.id, { query: message, limit: 10 });
  if (memories.length > 0) void markUsed(memories.map((m) => m.id));
  void recordTelemetry({
    category: 'memory', action: 'retrieved', status: 'success', userId: ctx.user.id,
    requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
    count: memories.length,
  });

  const assembled = assembleContext({
    request: message,
    history,
    ...(revision ? { activeAction: { tool: revision.tool, preview: revision.preview, state: 'being_revised' as const } } : {}),
  });
  const selectedSkills = selectSkills(assembled.skillQuery);
  void recordTelemetry({
    category: 'context', action: 'assembled', status: 'success', userId: ctx.user.id,
    requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
    candidateMessages: assembled.metrics.candidateMessages,
    selectedMessages: assembled.metrics.selectedMessages,
    estimatedTokens: assembled.metrics.estimatedTokens,
    count: assembled.metrics.recentFacts,
  });
  const mode = classifyResponseMode(message);
  const presentation = responsePolicy(mode);
  const modelPolicy = resolveModelPolicy(mode);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt(ctx.user, new Date(), message, {
        memory: memories.map((m) => ({
          type: m.type, title: m.title, content: m.content, scope: m.scope,
          scopeRef: m.scopeRef, source: m.source, expiresAt: m.expiresAt,
        })),
        skillQuery: assembled.skillQuery,
        responseMode: mode,
        conversationContext: assembled,
      }),
    },
    ...assembled.messages,
    ...(revision ? [{
      role: 'system' as const,
      content:
        'The Director is revising the previous pending action. That old proposal has been cancelled. ' +
        'Prepare one replacement action that preserves its requested changes and applies the new instruction. ' +
        'Use the registered write tool immediately; do not ask whether to prepare the approval card. ' +
        'Preserve the earlier validated arguments unless the Director changed them.',
    }] : []),
    { role: 'user', content: message },
  ];

  const steps: AgentStep[] = [];
  const tools = toolDefinitions(toolsForSkills(selectedSkills));
  const provider = aiProvider(modelPolicy.role);

  try {
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      // Hard stop before spending, not after.
      try {
        await assertWithinBudget(modelPolicy.budgetCategory);
      } catch (err) {
        void recordTelemetry({
          category: 'model', action: 'call', status: 'failed', userId: ctx.user.id,
          requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
          model: modelPolicy.model, modelRole: modelPolicy.role, responseMode: mode,
          budgetCategory: modelPolicy.budgetCategory, purpose: 'chat', iteration,
          reasonCode: err instanceof AppError ? err.code : 'budget_check_failed',
        });
        throw err;
      }

      let result;
      const callStarted = Date.now();
      try {
        result = await provider.chat({
          messages,
          tools,
          signal,
          temperature: 0.3,
          maxTokens: presentation.maxTokens,
          reasoningEffort: modelPolicy.reasoningEffort,
        });
      } catch (err) {
        void recordTelemetry({
          category: 'model', action: 'call', status: 'failed', userId: ctx.user.id,
          requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
          model: modelPolicy.model, modelRole: modelPolicy.role, responseMode: mode,
          budgetCategory: modelPolicy.budgetCategory, purpose: 'chat', iteration,
          durationMs: Date.now() - callStarted, reasonCode: 'provider_error',
        });
        throw toFriendlyAiError(err, modelPolicy.model);
      }

      if (result.usage) {
        const costMicros = await recordUsage({
          userId: ctx.user.id,
          model: result.model,
          purpose: 'chat',
          budgetCategory: modelPolicy.budgetCategory,
          requestId: ctx.requestId,
          conversationId: ctx.conversationId,
          workflowId: ctx.workflowId,
          modelRole: modelPolicy.role,
          responseMode: mode,
          iteration,
          usage: result.usage,
          durationMs: Date.now() - callStarted,
        });
        void recordTelemetry({
          category: 'model', action: 'call', status: 'success', userId: ctx.user.id,
          requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
          model: result.model, modelRole: modelPolicy.role, responseMode: mode,
          budgetCategory: modelPolicy.budgetCategory, purpose: 'chat', iteration,
          durationMs: Date.now() - callStarted, promptTokens: result.usage.promptTokens,
          cachedTokens: result.usage.cachedTokens ?? 0, completionTokens: result.usage.completionTokens,
          costMicros,
        });
      } else {
        void recordTelemetry({
          category: 'model', action: 'call', status: 'success', userId: ctx.user.id,
          requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
          model: result.model, modelRole: modelPolicy.role, responseMode: mode,
          budgetCategory: modelPolicy.budgetCategory, purpose: 'chat', iteration,
          durationMs: Date.now() - callStarted, reasonCode: 'usage_unavailable',
        });
      }

      // No tool calls means the model is answering.
      if (result.toolCalls.length === 0) {
        const raw = result.content.trim();

        // A model-written preview has no executable approval behind it. Give
        // the model one correction attempt per iteration; never show the fake
        // preview or invite the Director to confirm something that cannot run.
        const invalidActionReply =
          isActionRequest(message) ||
          isApprovalRevisionRequest(message) ||
          revision !== null ||
          looksLikeApprovalPrompt(raw) ||
          looksLikeInternalProcess(raw);
        if (invalidActionReply && !steps.some((step) => step.status === 'approval_required')) {
          if (iteration < MAX_ITERATIONS) {
            messages.push({ role: 'assistant', content: raw });
            messages.push({
              role: 'system',
              content:
                'The Director requested a Microsoft 365 change. Do not describe your workflow or write a preview yourself. ' +
                'Use the relevant read tool to identify the exact item if needed, then call the registered write tool. ' +
                'Only the write tool can create the real Yes/No approval card.',
            });
            logger.warn({ iteration, question: message.slice(0, 80) }, 'Rejected model-written action preview');
            continue;
          }
          return {
            reply: 'I understood the change, but I could not prepare a reliable approval for it. Nothing was changed.',
            steps,
            iterations: iteration,
            model: result.model,
            durationMs: Date.now() - started,
          };
        }

        // Last gate: never pass on a claim of action that nothing backs up.
        const checked = checkClaims(raw, steps);
        if (checked.blocked) {
          logger.error({ reason: checked.reason, raw: raw.slice(0, 200) }, 'Blocked an unbacked action claim');
          void recordTelemetry({
            category: 'security', action: 'false_action_blocked', status: 'success', userId: ctx.user.id,
            requestId: ctx.requestId, conversationId: ctx.conversationId, workflowId: ctx.workflowId,
            model: result.model, modelRole: modelPolicy.role, responseMode: mode, reasonCode: 'unbacked_action_claim',
          });
        }

        return {
          reply:
            checked.reply ||
            'I understood what you were asking, but I could not produce a reliable answer from what I could verify. Nothing has been changed.',
          steps,
          iterations: iteration,
          model: result.model,
          durationMs: Date.now() - started,
        };
      }

      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

      // Process in order. As soon as a write needs approval, stop: only one
      // concrete proposal may be pending in a conversation at a time.
      const outcomes: ToolOutcome[] = [];
      for (const call of result.toolCalls) {
        const outcome = await executeTool(call.name, call.arguments, { ...ctx, signal });
        outcomes.push(outcome);
        if (outcome.status === 'approval_required') break;
      }

      result.toolCalls.slice(0, outcomes.length).forEach((call, i) => {
        const outcome = outcomes[i]!;
        steps.push({ tool: outcome.name, summary: outcome.summary, status: outcome.status });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: formatToolResult(outcome.name, outcome.result, outcome.status === 'failed'),
        });
      });

      const approvalOutcome = outcomes.find((o) => o.approval);
      if (approvalOutcome?.approval) {
        const approval = approvalOutcome.approval;
        return {
          reply: formatApprovalPreview(approval.preview),
          steps,
          iterations: iteration,
          model: result.model,
          durationMs: Date.now() - started,
          approval: { id: approval.id, preview: approval.preview, expiresAt: approval.expiresAt },
        };
      }

      logger.debug({ iteration, tools: outcomes.map((o) => o.name) }, 'Agent iteration');
    }

    // Ran out of iterations. Do not ask her to rephrase a request that may
    // already have been perfectly clear.
    return {
      reply:
        'I understood the request, but I could not verify enough to give you a dependable answer. Nothing has been changed.',
      steps,
      iterations: MAX_ITERATIONS,
      model: provider.model,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatApprovalPreview(preview: ActionPreview): string {
  const details = preview.details.map((d) => `• ${d.label}: ${d.value}`).join('\n');
  return [
    `## ${preview.title}`,
    preview.summary,
    details,
    preview.warning ? `Important: ${preview.warning}` : '',
    'Please reply Yes to proceed or No to cancel.',
  ].filter(Boolean).join('\n\n');
}

function toFriendlyAiError(err: unknown, _model: string): AppError {
  if (err instanceof AppError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const apiError = err as { status?: number; code?: string; param?: string };

  if (/abort/i.test(message)) {
    return new AppError(504, 'ai_timeout', 'That took too long and I stopped it.', 'The model did not finish in time.');
  }

  if (/ECONNREFUSED|fetch failed|ENOTFOUND|socket hang up/i.test(message)) {
    return new AppError(
      503,
      'ai_unreachable',
      'I cannot reach the AI model.',
      'Check the network connection and OpenAI service status, then try again.',
    );
  }

  if (
    apiError.status === 404 &&
    (apiError.code === 'model_not_found' || apiError.param === 'model' || /model.+not found/i.test(message))
  ) {
    return new AppError(
      503,
      'ai_model_missing',
      'The language service is unavailable right now.',
      'Nothing was changed. Check the service configuration before trying again.',
    );
  }

  logger.error({ err }, 'AI provider error');
  return Errors.internal();
}
