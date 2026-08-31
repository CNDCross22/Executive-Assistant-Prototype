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
  chat(options: ChatOptions): Promise<ChatResult>;
  /** Cheap liveness check used by the setup screen and diagnostics. */
  health(): Promise<{ ok: boolean; detail: string }>;
}
