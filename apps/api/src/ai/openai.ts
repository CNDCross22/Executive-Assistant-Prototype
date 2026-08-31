import OpenAI from 'openai';
import type { AIProvider, ChatOptions, ChatResult, ChatMessage, ToolDefinition } from './provider.js';
import type { ReasoningEffort } from './policy.js';
import { logger } from '../lib/logger.js';

export function tokenLimitOptions(
  model: string,
  maxTokens: number,
  temperature: number,
  reasoningEffort: ReasoningEffort = 'minimal',
) {
  return /^gpt-5(?:[.-]|$)/i.test(model)
    ? { max_completion_tokens: maxTokens, reasoning_effort: reasoningEffort }
    : { max_tokens: maxTokens, temperature };
}

/** The application's single model integration: the official OpenAI API. */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    readonly reasoningEffort: ReasoningEffort = 'minimal',
  ) {
    this.client = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 2 });
  }

  private toApiMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (message.role === 'tool') {
        return { role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? '' };
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function' as const,
            function: { name: toolCall.name, arguments: toolCall.arguments },
          })),
        };
      }
      return { role: message.role, content: message.content } as OpenAI.Chat.ChatCompletionMessageParam;
    });
  }

  private toApiTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const { messages, tools, temperature = 0.2, maxTokens = 1200, signal } = options;
    const completion = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.toApiMessages(messages),
        ...(tools?.length ? { tools: this.toApiTools(tools), tool_choice: 'auto' } : {}),
        // GPT-5 chat models use max_completion_tokens and only accept their
        // default sampling temperature. Older models retain the legacy fields.
        ...tokenLimitOptions(this.model, maxTokens, temperature, options.reasoningEffort ?? this.reasoningEffort),
      },
      { signal },
    );

    const raw = completion.choices[0]?.message;
    if (!raw?.content && !raw?.tool_calls?.length) {
      logger.warn(
        { model: completion.model, finishReason: completion.choices[0]?.finish_reason, usage: completion.usage },
        'OpenAI returned an empty assistant message',
      );
    }
    return {
      content: raw?.content ?? '',
      toolCalls: (raw?.tool_calls ?? []).flatMap((call) =>
        'function' in call
          ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments || '{}' }]
          : [],
      ),
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            cachedTokens: completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
          }
        : undefined,
      model: completion.model ?? this.model,
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
