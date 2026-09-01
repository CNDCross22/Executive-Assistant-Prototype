/**
 * Cached executive briefing. Deterministic dashboard data remains the source
 * of truth; the model is an optional writing layer with a zero-model fallback.
 */
import { aiProvider } from '../ai/index.js';
import { assertWithinBudget, recordUsage } from '../ai/cost.js';
import { responsePolicy } from '../agent/response-policy.js';
import { sanitiseReply } from '../agent/sanitise.js';
import { resolveModelPolicy } from '../ai/policy.js';
import { logger } from '../lib/logger.js';
import { createOperationContext } from '../observability/context.js';
import { recordTelemetry } from '../observability/telemetry.js';
import { briefingMaterials, enforceBriefingFollowUps, renderDeterministicBriefing } from './briefing-policy.js';
import type { DashboardData } from './service.js';

export interface Briefing {
  available: boolean;
  text: string;
  generatedAt: string;
  /** Present when a deterministic report replaced model-written analysis. */
  unavailableReason?: string;
  cached: boolean;
}

interface CacheEntry {
  briefing: Briefing;
  signature: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_AGE_MS = 20 * 60 * 1000;
const MIN_REGEN_MS = 3 * 60 * 1000;

function signatureOf(data: DashboardData): string {
  return [
    data.needsYou.map((item) => `${item.ref}:${item.subject}:${item.unread}:${Boolean(item.warning)}:${item.priorityScore}:${item.statedDeadline?.statedText ?? ''}:${item.recommendation.action}`).join('|'),
    data.owedByYou.map((item) => `${item.person}:${item.subject}:${item.daysWaiting}`).join('|'),
    data.waitingOnThem.map((item) => `${item.person}:${item.subject}:${item.daysWaiting}`).join('|'),
    data.inbox.unreadCount,
    data.inbox.filteredOut,
  ].join('#');
}

function deterministic(data: DashboardData, reason?: string): Briefing {
  return {
    available: true,
    text: renderDeterministicBriefing(data),
    generatedAt: new Date().toISOString(),
    ...(reason ? { unavailableReason: reason } : {}),
    cached: false,
  };
}

export async function generateBriefing(
  userId: string,
  displayName: string,
  data: DashboardData,
  options: { force?: boolean; requestId?: string } = {},
): Promise<Briefing> {
  const operation = createOperationContext({
    requestId: options.requestId ?? `briefing-${Date.now()}`,
    userId,
    source: 'briefing',
  });
  const signature = signatureOf(data);
  const cached = cache.get(userId);

  if (!options.force && cached) {
    const age = Date.now() - cached.at;
    if (cached.signature === signature && age < MAX_AGE_MS) return { ...cached.briefing, cached: true };
    if (cached.signature !== signature && age < MIN_REGEN_MS) return { ...cached.briefing, cached: true };
  }

  if (data.needsYou.length === 0 && data.owedByYou.length === 0 && data.waitingOnThem.length === 0) {
    const briefing = deterministic(data);
    cache.set(userId, { briefing, signature, at: Date.now() });
    void recordTelemetry({
      category: 'briefing', action: 'generated', status: 'success', userId,
      requestId: operation.requestId, workflowId: operation.workflowId,
      durationMs: 0, reasonCode: 'deterministic_empty',
    });
    return briefing;
  }

  const presentation = responsePolicy('briefing');
  const modelPolicy = resolveModelPolicy('briefing');
  try {
    await assertWithinBudget(modelPolicy.budgetCategory);
  } catch {
    void recordTelemetry({
      category: 'briefing', action: 'generated', status: 'failed', userId,
      requestId: operation.requestId, workflowId: operation.workflowId,
      model: modelPolicy.model, modelRole: modelPolicy.role, responseMode: 'briefing',
      budgetCategory: modelPolicy.budgetCategory, reasonCode: 'budget_exhausted',
    });
    return deterministic(data, 'The monthly briefing budget is used up. This report uses the verified mailbox summary without model-written analysis.');
  }

  const { system, facts } = briefingMaterials(displayName, data);
  try {
    const provider = aiProvider(modelPolicy.role);
    const started = Date.now();
    const result = await provider.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: facts },
      ],
      temperature: 0.3,
      maxTokens: presentation.maxTokens,
      reasoningEffort: modelPolicy.reasoningEffort,
    });

    if (result.usage) {
      const costMicros = await recordUsage({
        userId,
        model: result.model,
        purpose: 'briefing',
        budgetCategory: modelPolicy.budgetCategory,
        requestId: operation.requestId,
        workflowId: operation.workflowId,
        modelRole: modelPolicy.role,
        serviceTier: result.serviceTier,
        responseMode: 'briefing',
        iteration: 1,
        usage: result.usage,
        durationMs: Date.now() - started,
      });
      void recordTelemetry({
        category: 'model', action: 'call', status: 'success', userId,
        requestId: operation.requestId, workflowId: operation.workflowId,
        model: result.model, modelRole: modelPolicy.role, responseMode: 'briefing',
        serviceTier: result.serviceTier,
        budgetCategory: modelPolicy.budgetCategory, purpose: 'briefing', durationMs: Date.now() - started,
        promptTokens: result.usage.promptTokens, cachedTokens: result.usage.cachedTokens ?? 0,
        completionTokens: result.usage.completionTokens, costMicros,
      });
    }

    const modelText = sanitiseReply(result.content);
    if (!modelText) return deterministic(data, 'The model-written analysis was empty. This report uses the verified mailbox summary.');
    const text = enforceBriefingFollowUps(modelText, data);

    const briefing: Briefing = { available: true, text, generatedAt: new Date().toISOString(), cached: false };
    cache.set(userId, { briefing, signature, at: Date.now() });
    void recordTelemetry({
      category: 'briefing', action: 'generated', status: 'success', userId,
      requestId: operation.requestId, workflowId: operation.workflowId,
      model: result.model, modelRole: modelPolicy.role, responseMode: 'briefing',
      budgetCategory: modelPolicy.budgetCategory, durationMs: Date.now() - started,
    });
    return briefing;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Briefing generation failed');
    void recordTelemetry({
      category: 'briefing', action: 'generated', status: 'failed', userId,
      requestId: operation.requestId, workflowId: operation.workflowId,
      model: modelPolicy.model, modelRole: modelPolicy.role, responseMode: 'briefing',
      budgetCategory: modelPolicy.budgetCategory, reasonCode: 'generation_error',
    });

    if (/credit|quota|billing/i.test(message)) {
      return deterministic(data, 'Model credits are unavailable. This report uses the verified mailbox summary.');
    }
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(message)) {
      return deterministic(data, 'Model-written analysis is unavailable right now. This report uses the verified mailbox summary.');
    }
    return deterministic(data, 'Model-written analysis could not be produced. This report uses the verified mailbox summary.');
  }
}
