/**
 * Internal model boundary used by the OpenAI integration.
 */
import type { ReasoningEffort } from './policy.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Present on assistant turns that asked for tools. */
  toolCalls?: ToolCallRequest[];
  /** Present on tool results. */
  toolCallId?: string;
  name?: string;
  /**
   * Provider-owned continuation data for one in-memory tool loop. It is never
   * persisted, logged, exposed to the Director, or interpreted by the agent.
   */
  providerState?: unknown[];
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string from the model; validated before use. */
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCallRequest[];
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
  model: string;
  /** Processing tier OpenAI actually used, which may differ from the request. */
  serviceTier?: string;
  /** Stateless Responses API items needed to preserve reasoning across tools. */
  providerState?: unknown[];
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Explicit per-purpose policy. Defaults to the provider configuration. */
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly serviceTier: 'default' | 'fast';
  chat(options: ChatOptions): Promise<ChatResult>;
  /** Cheap liveness check used by the setup screen and diagnostics. */
  health(): Promise<{ ok: boolean; detail: string }>;
}
