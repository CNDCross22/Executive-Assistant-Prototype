import { env } from '../config/env.js';
import type { AIProvider } from './provider.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';

let cached: AIProvider | null = null;

export function aiProvider(): AIProvider {
  if (cached) return cached;

  switch (env.AI_PROVIDER) {
    case 'openai-compatible':
      cached = new OpenAICompatibleProvider(env.AI_MODEL, env.AI_BASE_URL, env.AI_API_KEY);
      break;
    case 'anthropic':
      // Deliberately not implemented yet: nothing in the product needs it, and
      // an untested adapter is worse than an honest gap. The interface is ready.
      throw new Error('The Anthropic provider is not implemented yet. Set AI_PROVIDER=openai-compatible.');
    default:
      throw new Error(`Unknown AI_PROVIDER: ${env.AI_PROVIDER}`);
  }

  return cached;
}

export type { AIProvider } from './provider.js';
