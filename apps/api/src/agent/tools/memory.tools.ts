import { z } from 'zod';
import { defineTool, objectSchema, type Tool } from './types.js';
import { remember, recall, forget, getMemory, listMemory } from '../../memory/store.js';

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
    key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/).optional(),
    importance: z.number().int().min(1).max(5).default(3),
    scope: z.enum(['global', 'person', 'project', 'communication', 'calendar', 'email', 'operational']).default('global'),
    scopeRef: z.string().min(1).max(200).optional(),
    expiresAt: z.string().datetime().optional(),
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
      key: { type: 'string', description: 'Stable lower-case key, such as style.email.brevity or person.james.role.' },
      importance: { type: 'integer', description: '1 trivial to 5 critical.', default: 3 },
      scope: { type: 'string', enum: ['global', 'person', 'project', 'communication', 'calendar', 'email', 'operational'], description: 'Where the memory applies. Use global unless the Director clearly limited it.' },
      scopeRef: { type: 'string', description: 'Normalised person, project or matter association for a specific scope.' },
      expiresAt: { type: 'string', description: 'ISO timestamp only when the Director made the preference temporary.' },
    },
    ['type', 'title', 'content'],
  ),
  summarise: (a) => `Remembered: ${a.title}`,
  preview: (a) => ({
    title: 'Remember this for future work?',
    summary: a.title,
    details: [
      { label: 'What I will remember', value: a.content },
      { label: 'Type', value: a.type.replace('_', ' ') },
      ...(a.subject ? [{ label: 'About', value: a.subject }] : []),
      { label: 'Applies to', value: a.scopeRef ? `${a.scope}: ${a.scopeRef}` : a.scope },
      ...(a.expiresAt ? [{ label: 'Expires', value: a.expiresAt }] : []),
    ],
  }),
  async execute(args, ctx) {
    const generatedKey = args.key ?? `${args.type}.${args.title.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 60)}`;
    const entry = await remember({
      userId: ctx.user.id,
      type: args.type,
      title: args.title,
      content: args.content,
      subject: args.subject ?? null,
      key: generatedKey,
      importance: args.importance,
      source: 'explicit',
      confidence: 1,
      scope: args.scope,
      scopeRef: args.scopeRef ?? null,
      expiresAt: args.expiresAt ?? null,
    });

    if (!entry) throw new Error('The memory could not be saved.');
    return { saved: true, memoryRef: ctx.refs.ref(entry.id), title: entry.title };
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
      entries: entries.map((e) => ({
        ref: ctx.refs.ref(e.id), type: e.type, title: e.title, content: e.content,
        scope: e.scope, about: e.scopeRef, source: e.source, expiresAt: e.expiresAt,
      })),
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
  schema: z.object({ memoryRef: z.string().regex(/^e\d+$/), title: z.string().min(1).max(120).default('Selected memory') }),
  parameters: objectSchema(
    {
      memoryRef: { type: 'string', description: 'The opaque reference from memory_recall.' },
      title: { type: 'string', description: 'Its title, so the confirmation is readable.' },
    },
    ['memoryRef', 'title'],
  ),
  summarise: (a) => `Forgot: ${a.title}`,
  preview: async (a, ctx) => {
    const id = ctx.refs.resolve(a.memoryRef);
    if (!id) throw new Error('That memory reference is no longer available. Look it up again first.');
    const entry = await getMemory(ctx.user.id, id);
    if (!entry) throw new Error('That saved memory no longer exists.');
    return ({
    title: 'Forget this permanently?',
    summary: entry.title,
    details: [{ label: 'What will be forgotten', value: entry.content }],
    warning: 'This removes the saved memory and cannot be undone.',
  }); },
  async execute(args, ctx) {
    const id = ctx.refs.resolve(args.memoryRef);
    if (!id) throw new Error('That memory reference is no longer available. Look it up again first.');
    await forget(ctx.user.id, id);
    return { forgotten: true };
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
      remembered: active.map((e) => ({
        ref: ctx.refs.ref(e.id), type: e.type, title: e.title, content: e.content,
        scope: e.scope, about: e.scopeRef, source: e.source, expiresAt: e.expiresAt,
      })),
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
