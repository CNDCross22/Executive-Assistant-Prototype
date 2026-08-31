import { env } from '../config/env.js';
import type { AIProvider } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { modelForRole, reasoningEffortForRole, type ModelRole } from './policy.js';

const cached = new Map<string, AIProvider>();

export function aiProvider(role: ModelRole = 'executive'): AIProvider {
  const model = modelForRole(role);
  const reasoningEffort = reasoningEffortForRole(role);
  const key = `${model}:${reasoningEffort}`;
  const existing = cached.get(key);
  if (existing) return existing;

  const provider = new OpenAIProvider(model, env.OPENAI_API_KEY ?? 'missing', reasoningEffort);
  cached.set(key, provider);
  return provider;
}

export type { AIProvider } from './provider.js';
