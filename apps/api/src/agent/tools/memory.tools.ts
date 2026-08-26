import { z } from 'zod';
import { defineTool, objectSchema, type Tool } from './types.js';
import { remember, recall, forget, listMemory } from '../../memory/store.js';

/**
 * Memory tools.
 *
 * Risk levels matter here. Saving and recalling are level 1 — private, local,
 * reversible, and she can see everything in the Memory view. FORGETTING is
 * level 3, because a model deleting what it knows about her without asking is
 * both destructive and invisible.
 */

const rememberTool = defineTool({
  name: 'memory_remember',
  description:
    'Save something worth knowing long term. Use ONLY when she states a preference, a fact about a ' +
    'person, or how she wants something done — "never book me before 9", "James is the CFO", ' +
    '"keep my replies short". Do not save passing remarks, task details, or anything about a single ' +
    'email. If in doubt, do not save.',
  riskLevel: 1,
  capability: 'identity',
  schema: z.object({
    type: z.enum(['preference', 'person', 'working_style', 'operational', 'procedural']),
    title: z.string().min(3).max(120),
    content: z.string().min(3).max(1000),
    subject: z.string().max(200).optional(),
    importance: z.number().int().min(1).max(5).default(3),
  }),
  parameters: objectSchema(
    {
      type: {
        type: 'string',
        enum: ['preference', 'person', 'working_style', 'operational', 'procedural'],
        description:
          'preference = how she wants things done. person = a fact about someone. ' +
          'working_style = how she operates. operational = a rule for you. procedural = how to do a task.',
      },
      title: { type: 'string', description: 'Short label, e.g. "No meetings before 9am".' },
      content: { type: 'string', description: 'The fact itself, in one or two sentences.' },
      subject: { type: 'string', description: 'For type=person, their email address.' },
      importance: { type: 'integer', description: '1 trivial to 5 critical.', default: 3 },
    },
    ['type', 'title', 'content'],
  ),
  summarise: (a) => `Remembered: ${a.title}`,
  async execute(args, ctx) {
    const entry = await remember({
      userId: ctx.user.id,
      type: args.type,
      title: args.title,
      content: args.content,
      subject: args.subject ?? null,
      importance: args.importance,
      source: 'explicit',
      confidence: 1,
    });

    return entry
      ? { saved: true, id: entry.id, title: entry.title }
      : { saved: false, message: 'Could not save that. Tell her it was not stored.' };
  },
});

const recallTool = defineTool({
  name: 'memory_recall',
  description:
    'Look up what you already know about her, a person, or how she likes something done. ' +
    'Use when a question depends on her preferences or on context about someone.',
  riskLevel: 0,
  capability: 'identity',
  schema: z.object({
    query: z.string().max(200).optional(),
    about: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(15).default(8),
  }),
  parameters: objectSchema({
    query: { type: 'string', description: 'What you are looking for, in words.' },
    about: { type: 'string', description: 'A person’s email address, to get facts about them.' },
    limit: { type: 'integer', default: 8 },
  }),
  summarise: (a) => (a.about ? `Recalled what I know about ${a.about}` : 'Checked what I know'),
  async execute(args, ctx) {
    const entries = await recall(ctx.user.id, {
      query: args.query,
      subject: args.about,
      limit: args.limit,
    });

    return {
      count: entries.length,
      entries: entries.map((e) => ({ type: e.type, title: e.title, content: e.content })),
    };
  },
});

const forgetTool = defineTool({
  name: 'memory_forget',
  description:
    'Permanently delete something you know. Use only when she explicitly asks you to forget it. ' +
    'Find the exact entry with memory_recall first.',
  // Level 3: destructive and invisible. Goes through approval once that exists.
  riskLevel: 3,
  capability: 'identity',
  schema: z.object({ id: z.string().min(1), title: z.string().max(120).optional() }),
  parameters: objectSchema(
    {
      id: { type: 'string', description: 'The memory id from memory_recall.' },
      title: { type: 'string', description: 'Its title, so the confirmation is readable.' },
    },
    ['id'],
  ),
  summarise: (a) => `Forget: ${a.title ?? a.id}`,
  async execute(args, ctx) {
    await forget(ctx.user.id, args.id);
    return { forgotten: true, id: args.id };
  },
});

const listTool = defineTool({
  name: 'memory_list',
  description:
    'List everything you currently remember about her. Use when she asks "what do you know about me" ' +
    'or wants to review what has been stored.',
  riskLevel: 0,
  capability: 'identity',
  schema: z.object({}),
  parameters: objectSchema({}),
  summarise: () => 'Listed what I remember',
  async execute(_args, ctx) {
    const entries = await listMemory(ctx.user.id);
    const active = entries.filter((e) => e.status === 'active');
    const proposed = entries.filter((e) => e.status === 'proposed');

    return {
      remembered: active.map((e) => ({ id: e.id, type: e.type, title: e.title, content: e.content })),
      awaitingHerApproval: proposed.map((e) => ({ title: e.title, content: e.content })),
    };
  },
});

export const memoryTools: Tool<never>[] = [
  rememberTool,
  recallTool,
  forgetTool,
  listTool,
] as unknown as Tool<never>[];
