import { env } from '../config/env.js';
import type { ResponseMode } from '../agent/response-policy.js';

export type ModelRole = 'fast' | 'executive' | 'briefing' | 'background';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type BudgetCategory = 'interactive' | 'briefing' | 'background';
export type ServiceTier = 'default' | 'fast';

export interface ModelPolicy {
  role: ModelRole;
  model: string;
  reasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
  budgetCategory: BudgetCategory;
}

export function modelRoleForResponse(mode: ResponseMode): ModelRole {
  if (mode === 'briefing') return 'briefing';
  if (mode === 'executive' || mode === 'draft' || mode === 'sensitive') return 'executive';
  return 'fast';
}

export function modelForRole(role: ModelRole): string {
  const configured: Record<ModelRole, string | undefined> = {
    fast: env.OPENAI_FAST_MODEL,
    executive: env.OPENAI_EXECUTIVE_MODEL,
    briefing: env.OPENAI_BRIEFING_MODEL,
    background: env.OPENAI_BACKGROUND_MODEL,
  };
  return configured[role] ?? env.OPENAI_MODEL;
}

export function reasoningEffortForRole(role: ModelRole): ReasoningEffort {
  const configured: Record<ModelRole, ReasoningEffort | undefined> = {
    fast: env.OPENAI_FAST_REASONING_EFFORT,
    executive: env.OPENAI_EXECUTIVE_REASONING_EFFORT,
    briefing: env.OPENAI_BRIEFING_REASONING_EFFORT,
    background: env.OPENAI_BACKGROUND_REASONING_EFFORT,
  };
  return configured[role] ?? env.OPENAI_REASONING_EFFORT;
}

export function serviceTierForRole(role: ModelRole): ServiceTier {
  const configured: Record<ModelRole, ServiceTier | undefined> = {
    fast: env.OPENAI_FAST_SERVICE_TIER,
    executive: env.OPENAI_EXECUTIVE_SERVICE_TIER,
    briefing: env.OPENAI_BRIEFING_SERVICE_TIER,
    background: env.OPENAI_BACKGROUND_SERVICE_TIER,
  };
  return configured[role] ?? env.OPENAI_SERVICE_TIER;
}

export function budgetCategoryForRole(role: ModelRole): BudgetCategory {
  if (role === 'briefing') return 'briefing';
  if (role === 'background') return 'background';
  return 'interactive';
}

export function resolveModelPolicy(mode: ResponseMode): ModelPolicy {
  const role = modelRoleForResponse(mode);
  return {
    role,
    model: modelForRole(role),
    reasoningEffort: reasoningEffortForRole(role),
    serviceTier: serviceTierForRole(role),
    budgetCategory: budgetCategoryForRole(role),
  };
}

export function modelPolicySummary(): Record<ModelRole, {
  model: string;
  reasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
}> {
  return {
    fast: { model: modelForRole('fast'), reasoningEffort: reasoningEffortForRole('fast'), serviceTier: serviceTierForRole('fast') },
    executive: { model: modelForRole('executive'), reasoningEffort: reasoningEffortForRole('executive'), serviceTier: serviceTierForRole('executive') },
    briefing: { model: modelForRole('briefing'), reasoningEffort: reasoningEffortForRole('briefing'), serviceTier: serviceTierForRole('briefing') },
    background: { model: modelForRole('background'), reasoningEffort: reasoningEffortForRole('background'), serviceTier: serviceTierForRole('background') },
  };
}
