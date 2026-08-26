import { z } from 'zod';
import { defineTool, objectSchema, type Tool } from './types.js';
import { needsAttention, findFollowUps } from '../../mail/triage.js';
import { assessSuspicion } from '../../mail/suspicion.js';
import { looksAutomated } from '../../mail/triage.js';

/**
 * Mail tools. All read-only (risk 0) at this stage.
 *
 * Results are deliberately compact: a small model on modest hardware does
 * markedly better with tight, pre-digested input than with raw message dumps.
 * The heavy lifting happens in the deterministic triage layer, not the model.
 */

const needsAttentionTool = defineTool({
  name: 'mail_needs_attention',
  description:
    'The emails that actually require the user, ranked, with the reason each one matters. ' +
    'Use this for questions like "what needs me today", "what is important", "anything urgent". ' +
    'Automated and bulk mail is already filtered out.',
  riskLevel: 0,
  capability: 'mail_read',
  schema: z.object({
    limit: z.number().int().min(1).max(15).default(8),
    sinceHours: z.number().int().min(1).max(336).default(72),
  }),
  parameters: objectSchema({
    limit: { type: 'integer', description: 'How many to return (1-15).', default: 8 },
    sinceHours: { type: 'integer', description: 'Look back this many hours.', default: 72 },
  }),
  summarise: (a) => `Checked the inbox for what needs attention (last ${a.sinceHours}h)`,
  async execute(args, ctx) {
    const result = await needsAttention(ctx.mail, ctx.me, args);
    return {
      considered: result.consideredCount,
      filteredOut: result.filteredOutCount,
      items: result.items.map((m) => {
        const suspicion = assessSuspicion([m.subject, m.bodyPreview].join(' '), m.from?.address);
        return {
          ref: ctx.refs.ref(m.id),
          ...(suspicion.warning ? { SECURITY_WARNING: suspicion.warning } : {}),
          from: m.from ? `${m.from.name} <${m.from.address}>` : 'unknown',
          subject: m.subject,
          receivedAt: m.receivedAt,
          unread: !m.isRead,
          external: m.isExternal,
          whyItMatters: m.reasons,
          preview: m.bodyPreview.slice(0, 220),
        };
      }),
    };
  },
});

const followUpsTool = defineTool({
  name: 'mail_follow_ups',
  description:
    'Threads where nobody has replied. Returns two clearly named lists: ' +
    'theyHaveNotRepliedToYou (you wrote last, they owe you) and ' +
    'youHaveNotRepliedToThem (they wrote last, you owe them). ' +
    'Use for "what have I not replied to", "who is waiting on me", "has anyone got back to me". ' +
    'Read the list names carefully and report the direction the user actually asked about.',
  riskLevel: 0,
  capability: 'mail_read',
  schema: z.object({
    minDays: z.number().int().min(1).max(60).default(3),
    limit: z.number().int().min(1).max(15).default(8),
  }),
  parameters: objectSchema({
    minDays: { type: 'integer', description: 'Only threads silent this many days.', default: 3 },
    limit: { type: 'integer', description: 'Max per list.', default: 8 },
  }),
  summarise: (a) => `Looked for threads with no reply in ${a.minDays}+ days`,
  async execute(args, ctx) {
    const result = await findFollowUps(ctx.mail, ctx.me, args);

    // Field names are the whole ballgame here. "awaitingReply" was ambiguous —
    // awaiting whose reply? — and the model inverted both directions. These
    // names cannot be misread.
    return {
      theyHaveNotRepliedToYou: result.awaitingReply.map((f) => ({
        youWroteTo: f.counterpart,
        about: f.subject,
        youWroteDaysAgo: f.daysWaiting,
        note: 'You sent the last message. They have not come back to you.',
      })),
      youHaveNotRepliedToThem: result.owedByHer.map((f) => ({
        theyWroteToYou: f.counterpart,
        about: f.subject,
        theyWroteDaysAgo: f.daysWaiting,
        note: 'They sent the last message. You have not replied.',
      })),
    };
  },
});

const searchTool = defineTool({
  name: 'mail_search',
  description:
    'Full-text search of the mailbox. Use when the user names a person, company, or topic ' +
    '("what did Michael say about the contract"). Returns matching messages, newest first.',
  riskLevel: 0,
  capability: 'mail_read',
  schema: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  parameters: objectSchema(
    {
      query: { type: 'string', description: 'Search terms: a name, address, subject or keyword.' },
      limit: { type: 'integer', description: 'Max results.', default: 10 },
    },
    ['query'],
  ),
  summarise: (a) => `Searched email for "${a.query}"`,
  async execute(args, ctx) {
    const found = await ctx.mail.search(args.query, args.limit);
    // Newsletters and no-reply traffic are noise in a search too, not just in
    // triage. Keep them, but mark them so they are not reported as news.
    const results = found;
    return {
      count: results.length,
      note: 'Items marked bulk are newsletters or automated mail. Do not present them as updates from a person.',
      results: results.map((m) => ({
        ref: ctx.refs.ref(m.id),
        from: m.from ? `${m.from.name} <${m.from.address}>` : 'unknown',
        subject: m.subject,
        receivedAt: m.receivedAt,
        unread: !m.isRead,
        bulk: looksAutomated(m),
        preview: m.bodyPreview.slice(0, 220),
      })),
    };
  },
});

const readTool = defineTool({
  name: 'mail_read',
  description:
    'Read one full email. Either pass a short reference like "e1" from an earlier result, ' +
    'or pass find="some words" to locate and open the best match in one step. ' +
    'These references are internal — never repeat them to the user.',
  riskLevel: 0,
  capability: 'mail_read',
  schema: z
    .object({
      id: z.string().min(1).optional(),
      find: z.string().min(2).max(200).optional(),
    })
    .refine((v) => v.id || v.find, { message: 'Pass either id or find.' }),
  parameters: objectSchema({
    id: { type: 'string', description: 'A short reference like "e1" from an earlier result.' },
    find: {
      type: 'string',
      description: 'Words to search for, when you do not have an id. Example: "account verification".',
    },
  }),
  summarise: (a) => (a.find ? `Looked up the email about "${a.find}"` : 'Opened an email in full'),
  async execute(args, ctx) {
    let id = args.id ? ctx.refs.resolve(args.id) : undefined;

    // A model without an id will otherwise guess one. Searching is cheap and
    // removes the failure mode entirely.
    if (!id && args.find) {
      const matches = await ctx.mail.search(args.find, 3);
      const best = matches[0];
      if (!best) {
        return { found: false, searchedFor: args.find, message: 'No message matches that. Nothing was found.' };
      }
      id = best.id;
    }

    if (!id) return { found: false, message: 'No id and nothing to search for.' };

    const m = await ctx.mail.get(id);

    // Detected in code, not left to the model to notice.
    const suspicion = assessSuspicion([m.subject, m.body].join(' '), m.from?.address);

    return {
      found: true,
      ...(suspicion.warning ? { SECURITY_WARNING: suspicion.warning } : {}),
      from: m.from ? `${m.from.name} <${m.from.address}>` : 'unknown',
      to: m.toRecipients.map((r) => r.address),
      subject: m.subject,
      receivedAt: m.receivedAt,
      external: m.isExternal,
      // Flagged so the prompt layer wraps it as untrusted content.
      untrustedBody: m.body.slice(0, 6000),
    };
  },
});

const recentTool = defineTool({
  name: 'mail_recent',
  description:
    'The most recent messages in date order, without ranking. Use for "what came in this morning" ' +
    'or when the user wants a plain chronological view.',
  riskLevel: 0,
  capability: 'mail_read',
  schema: z.object({
    limit: z.number().int().min(1).max(25).default(10),
    unreadOnly: z.boolean().default(false),
  }),
  parameters: objectSchema({
    limit: { type: 'integer', description: 'How many.', default: 10 },
    unreadOnly: { type: 'boolean', description: 'Only unread messages.', default: false },
  }),
  summarise: (a) => (a.unreadOnly ? 'Listed unread email' : 'Listed recent email'),
  async execute(args, ctx) {
    const messages = await ctx.mail.list({ limit: args.limit, unreadOnly: args.unreadOnly });
    return {
      count: messages.length,
      messages: messages.map((m) => ({
        ref: ctx.refs.ref(m.id),
        from: m.from ? `${m.from.name} <${m.from.address}>` : 'unknown',
        subject: m.subject,
        receivedAt: m.receivedAt,
        unread: !m.isRead,
        preview: m.bodyPreview.slice(0, 160),
      })),
    };
  },
});

export const mailTools: Tool<never>[] = [
  needsAttentionTool,
  followUpsTool,
  searchTool,
  readTool,
  recentTool,
] as unknown as Tool<never>[];
