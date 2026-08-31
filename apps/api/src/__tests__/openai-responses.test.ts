import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIProvider } from '../ai/openai.js';
import type { ChatMessage } from '../ai/provider.js';

describe('OpenAI Responses provider', () => {
  test('uses stateless Responses requests and replays encrypted reasoning through a tool loop', async () => {
    const requests: Record<string, unknown>[] = [];
    const firstOutput = [
      {
        id: 'rs_1',
        type: 'reasoning',
        encrypted_content: 'opaque-encrypted-reasoning',
        summary: [],
        status: 'completed',
      },
      {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'mail_search',
        arguments: '{"query":"Sarah"}',
        status: 'completed',
      },
    ];
    let call = 0;
    const provider = new OpenAIProvider('gpt-5.6-sol', 'test-key', 'low', 'fast');
    Object.defineProperty(provider, 'client', {
      value: {
        responses: {
          create: async (request: Record<string, unknown>) => {
            requests.push(request);
            call++;
            return call === 1
              ? {
                  output_text: '',
                  output: firstOutput,
                  usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 15 },
                  },
                  model: 'gpt-5.6-sol',
                  service_tier: 'priority',
                  status: 'completed',
                  incomplete_details: null,
                }
              : {
                  output_text: 'Sarah needs a reply.',
                  output: [{
                    id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
                    content: [{ type: 'output_text', text: 'Sarah needs a reply.', annotations: [] }],
                  }],
                  usage: {
                    input_tokens: 160,
                    output_tokens: 8,
                    input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 2 },
                  },
                  model: 'gpt-5.6-sol',
                  service_tier: 'priority',
                  status: 'completed',
                  incomplete_details: null,
                };
          },
        },
      },
    });

    const first = await provider.chat({
      messages: [
        { role: 'system', content: 'Be accurate.' },
        { role: 'user', content: 'Check Sarah.' },
      ],
      tools: [{
        name: 'mail_search',
        description: 'Searches mail. Read-only.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }],
      maxTokens: 500,
    });

    assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'mail_search', arguments: '{"query":"Sarah"}' }]);
    assert.equal(first.serviceTier, 'priority');
    assert.deepEqual(first.usage, { promptTokens: 100, completionTokens: 20, cachedTokens: 10 });
    assert.equal(requests[0]?.store, false);
    assert.equal(requests[0]?.service_tier, 'fast');
    assert.deepEqual(requests[0]?.reasoning, { effort: 'low' });
    assert.deepEqual(requests[0]?.include, ['reasoning.encrypted_content']);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be accurate.' },
      { role: 'user', content: 'Check Sarah.' },
      {
        role: 'assistant',
        content: first.content,
        toolCalls: first.toolCalls,
        providerState: first.providerState,
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"subject":"Budget"}' },
    ];
    const second = await provider.chat({ messages, maxTokens: 500 });

    assert.equal(second.content, 'Sarah needs a reply.');
    const secondInput = requests[1]?.input as Array<Record<string, unknown>>;
    assert.equal(secondInput.filter((item) => item.type === 'reasoning').length, 1);
    assert.equal(secondInput.filter((item) => item.type === 'function_call').length, 1);
    assert.deepEqual(secondInput.at(-1), {
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"subject":"Budget"}',
    });
  });
});
