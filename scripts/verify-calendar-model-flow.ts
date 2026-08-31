import { aiProvider } from '../apps/api/src/ai/index.js';
import { formatToolResult } from '../apps/api/src/agent/prompt.js';
import { toolDefinitions } from '../apps/api/src/agent/registry.js';
import type { ChatMessage } from '../apps/api/src/ai/provider.js';

async function main(): Promise<void> {
  const provider = aiProvider('executive');
  const tools = toolDefinitions(['calendar_list', 'calendar_search', 'calendar_delete']);
  const messages: ChatMessage[] = [
  {
    role: 'system',
    content:
      'You are testing calendar tool selection. Read before changing. When the exact target is verified, call calendar_delete. ' +
      'Never write your own confirmation prompt. Use calendar_search when the title is known but the date is not.',
  },
  { role: 'user', content: 'Please remove the Melbourne Opera from my calendar, cancel it.' },
  ];

  const first = await provider.chat({ messages, tools, maxTokens: 300, reasoningEffort: provider.reasoningEffort });
  if (first.toolCalls.length !== 1 || first.toolCalls[0]?.name !== 'calendar_search') {
    throw new Error(`Expected calendar_search first, received ${first.toolCalls.map((call) => call.name).join(', ') || 'no tool'}.`);
  }

  messages.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls, providerState: first.providerState });
  messages.push({
  role: 'tool',
  toolCallId: first.toolCalls[0].id,
  name: 'calendar_search',
  content: formatToolResult('calendar_search', {
    count: 1,
    query: 'Melbourne Opera',
    events: [{
      ref: 'event_1', subject: 'Melbourne Opera', start: '2026-08-29T09:00:00', end: '2026-08-29T11:00:00',
      timezone: 'Australia/Sydney', location: 'Melbourne Opera', organiser: 'director@example.com',
      attendees: [{ name: 'Benedick Gabis', address: 'benedick@example.com', response: 'accepted' }],
      isAllDay: false, isCancelled: false,
    }],
    note: 'This is a verified Microsoft 365 match. No event has been changed.',
  }),
  });

  const second = await provider.chat({ messages, tools, maxTokens: 300, reasoningEffort: provider.reasoningEffort });
  if (second.toolCalls.length !== 1 || second.toolCalls[0]?.name !== 'calendar_delete') {
    throw new Error(`Expected calendar_delete after verification, received ${second.toolCalls.map((call) => call.name).join(', ') || 'no tool'}.`);
  }
  const args = JSON.parse(second.toolCalls[0].arguments) as { eventRef?: string };
  if (args.eventRef !== 'event_1') throw new Error('The model did not preserve the verified opaque event reference.');

  console.log(JSON.stringify({
    ok: true,
    model: second.model,
    firstTool: first.toolCalls[0].name,
    secondTool: second.toolCalls[0].name,
    preservedReference: true,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
