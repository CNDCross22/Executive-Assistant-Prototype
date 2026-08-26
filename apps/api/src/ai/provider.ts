/**
 * The one place the application knows about AI vendors.
 *
 * Everything above this file is provider-agnostic, so moving between OpenAI,
 * Azure OpenAI, Anthropic or a locally hosted model is a config change rather
 * than a rewrite.
 */

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
  signal?: AbortSignal;
}

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  chat(options: ChatOptions): Promise<ChatResult>;
  /** Cheap liveness check used by the setup screen and diagnostics. */
  health(): Promise<{ ok: boolean; detail: string }>;
}
