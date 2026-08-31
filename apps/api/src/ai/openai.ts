import OpenAI from 'openai';
import type {
  FunctionTool,
  ResponseInput,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import type { AIProvider, ChatOptions, ChatResult, ChatMessage, ToolDefinition } from './provider.js';
import type { ReasoningEffort, ServiceTier } from './policy.js';
import { logger } from '../lib/logger.js';

export function responseGenerationOptions(
  model: string,
  maxTokens: number,
  temperature: number,
  reasoningEffort: ReasoningEffort = 'none',
) {
  return /^gpt-5(?:[.-]|$)/i.test(model)
    ? { max_output_tokens: maxTokens, reasoning: { effort: reasoningEffort } }
    : { max_output_tokens: maxTokens, temperature };
}

/**
 * OpenAI Responses API integration.
 *
 * Hermes manages its own bounded conversation context and keeps Responses
 * stateless (`store: false`). Encrypted reasoning items are replayed only
 * inside the current in-memory tool loop so Sol can reason across function
 * calls without persisting chain-of-thought in Hermes or at OpenAI.
 */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    readonly reasoningEffort: ReasoningEffort = 'none',
    readonly serviceTier: ServiceTier = 'default',
  ) {
    this.client = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 2 });
  }

  private toApiInput(messages: ChatMessage[]): ResponseInput {
    const input: ResponseInput = [];

    for (const message of messages) {
      if (message.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId ?? '',
          output: message.content,
        });
        continue;
      }

      if (message.role === 'assistant' && message.providerState?.length) {
        // These items came directly from response.output. The Responses API
        // explicitly permits replaying them as input for stateless tool loops.
        input.push(...(message.providerState as ResponseInputItem[]));
        continue;
      }

      if (message.role === 'assistant' && message.toolCalls?.length) {
        for (const toolCall of message.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });
        }
        continue;
      }

      input.push({ role: message.role, content: message.content });
    }

    return input;
  }

  private toApiTools(tools: ToolDefinition[]): FunctionTool[] {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // Hermes validates every call with Zod immediately before execution.
      // Existing schemas are not all compatible with OpenAI strict mode.
      strict: false,
    }));
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const { messages, tools, temperature = 0.2, maxTokens = 1200, signal } = options;
    const response = await this.client.responses.create(
      {
        model: this.model,
        input: this.toApiInput(messages),
        ...(tools?.length ? { tools: this.toApiTools(tools), tool_choice: 'auto' as const } : {}),
        parallel_tool_calls: false,
        service_tier: this.serviceTier,
        store: false,
        include: ['reasoning.encrypted_content'],
        ...responseGenerationOptions(
          this.model,
          maxTokens,
          temperature,
          options.reasoningEffort ?? this.reasoningEffort,
        ),
      },
      { signal },
    );

    const toolCalls = response.output.flatMap((item) =>
      item.type === 'function_call'
        ? [{ id: item.call_id, name: item.name, arguments: item.arguments || '{}' }]
        : [],
    );
    if (!response.output_text && toolCalls.length === 0) {
      logger.warn(
        {
          model: response.model,
          status: response.status,
          incompleteReason: response.incomplete_details?.reason,
          usage: response.usage,
        },
        'OpenAI returned an empty assistant response',
      );
    }

    return {
      content: response.output_text ?? '',
      toolCalls,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            cachedTokens: response.usage.input_tokens_details.cached_tokens ?? 0,
          }
        : undefined,
      model: response.model ?? this.model,
      serviceTier: response.service_tier ?? undefined,
      providerState: response.output,
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.client.models.list();
      const available = models.data.some((model) => model.id === this.model);
      return available
        ? { ok: true, detail: `${this.model} available` }
        : { ok: false, detail: `OpenAI is reachable, but ${this.model} is unavailable to this account.` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'OpenAI is unreachable';
      logger.debug({ err: error }, 'OpenAI health check failed');
      return { ok: false, detail };
    }
  }
}
