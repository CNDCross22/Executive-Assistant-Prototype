/**
 * Answers common questions without involving the model.
 *
 * The deterministic layer already holds a complete, ranked answer to "what
 * needs me today" before any inference happens. Passing that through an 8B
 * model on a CPU costs two to three minutes and adds nothing but phrasing —
 * so for known question shapes we phrase it here and return instantly.
 *
 * Rules for everything in this file:
 *   - Only ever states facts that came from a tool.
 *   - Never summarises the CONTENTS of a message; it has not read one.
 *   - Falls through to the agent whenever the question is not a clean match.
 */
import type { ToolContext } from './tools/types.js';
import type { AgentResult } from './orchestrator.js';
import { needsAttention, findFollowUps } from '../mail/triage.js';
import { assessSuspicion } from '../mail/suspicion.js';

/** Join a list the way a person speaks it. */
function naturalList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function howLong(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours === 1) return 'an hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}

function firstNameOf(full: string): string {
  return full.split(/[\s<]/)[0] ?? full;
}

/** Strip an email address, leaving the person's name. */
function personName(counterpart: string): string {
  const match = counterpart.match(/^([^<]+)</);
  return (match?.[1] ?? counterpart).trim();
}

// --------------------------------------------------------------- matchers ---

const NEEDS_ATTENTION = [
  /what (needs|requires) (me|my attention)/i,
  /(anything|what.s) (important|urgent|pressing)/i,
  /what should i (look at|deal with|do)/i,
  /(catch me up|what did i miss|my day|priorit)/i,
  /anything (i should|needing|urgent)/i,
];

const FOLLOW_UPS = [
  /(not|n.t) (replied|responded|got back|heard)/i,
  /who.s waiting on me/i,
  /(anyone|anything) (waiting|outstanding|pending)/i,
  /follow.?ups?\b/i,
  /(need|do) i (to )?(reply|respond|chase)/i,
  /chase|chasing/i,
];

const UNREAD_COUNT = [/how many (unread|emails|messages)/i, /unread count/i];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

// --------------------------------------------------------------- answers ---

async function answerNeedsAttention(ctx: ToolContext): Promise<AgentResult> {
  const started = Date.now();
  const result = await needsAttention(ctx.mail, ctx.me, { limit: 6, sinceHours: 72 });

  const warnings: string[] = [];
  const lines = result.items.map((m) => {
    const who = m.from?.name ?? 'Someone';
    const when = howLong(m.receivedAt);
    const flags: string[] = [];
    if (m.importance === 'high') flags.push('marked high importance');
    if (!m.isRead && Date.parse(m.receivedAt) < Date.now() - 3 * 86_400_000) flags.push('still unread');

    const suspicion = assessSuspicion([m.subject, m.bodyPreview].join(' '), m.from?.address);
    if (suspicion.suspicious) {
      warnings.push(
        `Be careful with one from ${who} <${m.from?.address ?? 'unknown'}> about "${m.subject}" — ` +
          `it looks like a phishing attempt. I have not acted on it. Worth deleting and reporting.`,
      );
      return null;
    }

    const tail = flags.length ? ` — ${naturalList(flags)}` : '';
    return `${who} about "${m.subject}", ${when}${tail}`;
  });

  const real = lines.filter((l): l is string => l !== null);

  let reply: string;
  if (real.length === 0 && warnings.length === 0) {
    reply =
      result.consideredCount === 0
        ? 'Nothing has come in over the last few days.'
        : `Nothing needs you. ${result.consideredCount} messages arrived, but they are all newsletters, ` +
          `automated notices, or things you are only copied into.`;
  } else {
    const count = real.length;
    const opener =
      count === 0
        ? ''
        : count === 1
          ? 'One thing needs you: '
          : `${count === 2 ? 'Two' : count === 3 ? 'Three' : count === 4 ? 'Four' : String(count)} things need you. `;

    const body = count === 1 ? `${real[0]}.` : real.map((l) => `${l}.`).join(' ');
    const rest =
      result.filteredOutCount > 0
        ? ` The other ${result.filteredOutCount} can wait — newsletters, automated mail, and group threads.`
        : '';

    reply = `${opener}${body}${rest}`;
  }

  if (warnings.length) reply = `${warnings.join(' ')}\n\n${reply}`.trim();

  return {
    reply,
    steps: [{ tool: 'mail_needs_attention', summary: 'Checked what needs your attention', status: 'success' }],
    iterations: 0,
    model: 'direct',
    durationMs: Date.now() - started,
  };
}

async function answerFollowUps(ctx: ToolContext, question: string): Promise<AgentResult> {
  const started = Date.now();
  const { awaitingReply, owedByHer } = await findFollowUps(ctx.mail, ctx.me, { minDays: 3, limit: 6 });

  // "has anyone got back to me" asks about them; "what have I not replied to"
  // asks about her. Lead with whichever she asked for.
  const asksAboutThem = /(not|n.t) (got back|responded|replied to me)|waiting (on|for) (them|a reply)|chase/i.test(
    question,
  );

  const themLine =
    awaitingReply.length === 0
      ? 'Everyone has come back to you.'
      : `You are still waiting on ${naturalList(
          awaitingReply.map((f) => `${personName(f.counterpart)} about "${f.subject}", ${f.daysWaiting} days now`),
        )}.`;

  const herLine =
    owedByHer.length === 0
      ? 'You do not owe anyone a reply.'
      : `You owe a reply to ${naturalList(
          owedByHer.map((f) => `${personName(f.counterpart)} about "${f.subject}", ${f.daysWaiting} days now`),
        )}.`;

  const oldest = awaitingReply[0];
  const nudge =
    oldest && oldest.daysWaiting >= 7
      ? ` ${firstNameOf(personName(oldest.counterpart))} is the one worth chasing.`
      : '';

  const reply = asksAboutThem ? `${themLine}${nudge} ${herLine}` : `${herLine} ${themLine}${nudge}`;

  return {
    reply: reply.trim(),
    steps: [{ tool: 'mail_follow_ups', summary: 'Checked for threads with no reply', status: 'success' }],
    iterations: 0,
    model: 'direct',
    durationMs: Date.now() - started,
  };
}

async function answerUnreadCount(ctx: ToolContext): Promise<AgentResult> {
  const started = Date.now();
  const unread = await ctx.mail.list({ limit: 100, unreadOnly: true });

  const reply =
    unread.length === 0
      ? 'Nothing unread.'
      : unread.length === 1
        ? `One unread message, from ${unread[0]!.from?.name ?? 'an unknown sender'}.`
        : `${unread.length} unread.`;

  return {
    reply,
    steps: [{ tool: 'mail_recent', summary: 'Counted unread messages', status: 'success' }],
    iterations: 0,
    model: 'direct',
    durationMs: Date.now() - started,
  };
}

/**
 * Try to answer without the model. Returns null when the question is not a
 * clean match — the agent then handles it as normal.
 */
export async function tryFastPath(message: string, ctx: ToolContext): Promise<AgentResult | null> {
  const text = message.trim();

  // Anything long or multi-part is a real conversation, not a stock question.
  if (text.length > 120 || text.split('?').length > 2) return null;

  if (matches(UNREAD_COUNT, text)) return answerUnreadCount(ctx);
  if (matches(FOLLOW_UPS, text)) return answerFollowUps(ctx, text);
  if (matches(NEEDS_ATTENTION, text)) return answerNeedsAttention(ctx);

  return null;
}
