import OpenAI from 'openai';
import type {
  AIProvider,
  ChatOptions,
  ChatResult,
  ChatMessage,
  ToolDefinition,
} from './provider.js';
import { logger } from '../lib/logger.js';

/**
 * Works against anything speaking the OpenAI chat-completions shape:
 * OpenAI, Azure OpenAI, OpenRouter, vLLM, LM Studio, Ollama.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id = 'openai-compatible';
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    baseURL: string,
    apiKey: string,
  ) {
    this.client = new OpenAI({
      baseURL,
      apiKey: apiKey || 'not-needed',
      timeout: 180_000, // local models on modest hardware are slow, not broken
      maxRetries: 1,
    });
  }

  private toApiMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: t.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam;
    });
  }

  private toApiTools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const { messages, tools, temperature = 0.2, maxTokens = 1200, signal } = options;

    const completion = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.toApiMessages(messages),
        ...(tools?.length ? { tools: this.toApiTools(tools), tool_choice: 'auto' } : {}),
        temperature,
        max_tokens: maxTokens,
      },
      { signal },
    );

    const choice = completion.choices[0];
    const raw = choice?.message;

    return {
      content: raw?.content ?? '',
      toolCalls: (raw?.tool_calls ?? []).flatMap((c) =>
        'function' in c
          ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments || '{}' }]
          : [],
      ),
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            // Cached prompt tokens bill at roughly a tenth of the normal rate.
            cachedTokens: completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
          }
        : undefined,
      model: completion.model ?? this.model,
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.client.models.list();
      const names = models.data.map((m) => m.id);
      const present = names.some((n) => n === this.model || n.startsWith(this.model.split(':')[0] ?? ''));
      return present
        ? { ok: true, detail: `${this.model} available` }
        : {
            ok: false,
            detail: `Reachable, but "${this.model}" is not there. Available: ${names.slice(0, 5).join(', ') || 'none'}`,
          };
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unreachable';
      logger.debug({ err }, 'AI health check failed');
      return { ok: false, detail };
    }
  }
}
