import type { MailService, MailMessage } from '../graph/mail.service.js';
import { assessSuspicion } from './suspicion.js';
import { analyseMail, executivePrioritySignals, type ExecutiveMailAnalysis } from './executive.js';

/**
 * The rules layer.
 *
 * Everything here is deterministic: no model, no guessing, no possibility of a
 * confident wrong answer. It handles the large majority of "what matters?"
 * before any AI is involved, and it gets more accurate with more history
 * rather than less.
 */

export interface TriagedMessage extends MailMessage {
  score: number;
  /** Original deterministic routing score, preserved for audit and rollback. */
  deterministicScore: number;
  /** Additive, evidence-backed interpretation. */
  executiveAdjustment: number;
  executive: ExecutiveMailAnalysis;
  /** Plain-English reasons, in the order they were applied. */
  reasons: string[];
}

const AUTOMATED_PATTERNS = [
  /^no-?reply@/i,
  /^do-?not-?reply@/i,
  /^notifications?@/i,
  /^bounce/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^support@.*\.(zendesk|freshdesk|intercom)\./i,
];

const BULK_SUBJECT_PATTERNS = [
  /unsubscribe/i,
  /newsletter/i,
  /\bdigest\b/i,
  /\bwebinar\b/i,
  /% off\b/i,
  /\bsale\b/i,
];

export function looksAutomated(m: MailMessage): boolean {
  const addr = m.from?.address ?? '';
  if (AUTOMATED_PATTERNS.some((p) => p.test(addr))) return true;
  return BULK_SUBJECT_PATTERNS.some((p) => p.test(m.subject));
}

function hoursSince(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 3_600_000;
}

export interface TriageContext {
  /** Her own address, lower-cased. */
  me: string;
  /** Addresses she has emailed recently — a strong relevance signal. */
  knownCorrespondents: Set<string>;
  /** Conversation ids she has participated in. */
  ownThreads: Set<string>;
}

export function scoreMessage(m: MailMessage, ctx: TriageContext): TriagedMessage {
  let score = 0;
  const reasons: string[] = [];

  if (looksAutomated(m)) {
    return {
      ...m,
      score: -50,
      deterministicScore: -50,
      executiveAdjustment: 0,
      executive: analyseMail({ subject: m.subject, text: m.bodyPreview, hasAttachments: m.hasAttachments }),
      reasons: ['Automated or bulk mail'],
    };
  }

  const addressedDirectly = m.toRecipients.some((r) => r.address === ctx.me);
  const ccOnly = !addressedDirectly && m.ccRecipients.some((r) => r.address === ctx.me);

  if (addressedDirectly) {
    score += 30;
    reasons.push('Addressed to you directly');
  } else if (ccOnly) {
    score -= 10;
    reasons.push('You are only copied in');
  }

  if (m.from && ctx.knownCorrespondents.has(m.from.address)) {
    score += 25;
    reasons.push('From someone you correspond with');
  }

  if (m.conversationId && ctx.ownThreads.has(m.conversationId)) {
    score += 30;
    reasons.push('Reply in a thread you are part of');
  }

  if (!m.isRead) {
    score += 10;
    reasons.push('Unread');
  }

  if (m.importance === 'high') {
    score += 15;
    reasons.push('Flagged high importance');
  }

  if (m.isExternal) {
    score += 5;
    reasons.push('From outside the organisation');
  }

  const age = hoursSince(m.receivedAt);
  if (age > 72 && !m.isRead) {
    score += 10;
    reasons.push('Unread for more than three days');
  } else if (age < 4) {
    score += 5;
    reasons.push('Arrived recently');
  }

  const recipientCount = m.toRecipients.length + m.ccRecipients.length;
  if (recipientCount > 8) {
    score -= 15;
    reasons.push('Sent to a large group');
  }

  const deterministicScore = score;
  const suspicious = assessSuspicion(`${m.subject} ${m.bodyPreview}`, m.from?.address).suspicious;
  const executive = analyseMail({
    subject: m.subject,
    text: m.bodyPreview,
    hasAttachments: m.hasAttachments,
    suspicious,
  });
  const semanticSignals = executivePrioritySignals(executive);
  const executiveAdjustment = semanticSignals.reduce((total, signal) => total + signal.points, 0);
  reasons.push(...semanticSignals.map((signal) => signal.reason));
  return { ...m, score: score + executiveAdjustment, deterministicScore, executiveAdjustment, executive, reasons };
}

/** Build the signals that make scoring accurate, from her own sent mail. */
export async function buildContext(mail: MailService, me: string): Promise<TriageContext> {
  const sent = await mail.list({ folder: 'sentitems', limit: 100 }).catch(() => []);

  const knownCorrespondents = new Set<string>();
  const ownThreads = new Set<string>();

  for (const m of sent) {
    for (const r of [...m.toRecipients, ...m.ccRecipients]) {
      if (r.address !== me) knownCorrespondents.add(r.address);
    }
    if (m.conversationId) ownThreads.add(m.conversationId);
  }

  return { me, knownCorrespondents, ownThreads };
}

export interface NeedsAttentionResult {
  items: TriagedMessage[];
  consideredCount: number;
  filteredOutCount: number;
}

/** What actually needs her, ranked. */
export async function needsAttention(
  mail: MailService,
  me: string,
  options: { limit?: number; sinceHours?: number } = {},
): Promise<NeedsAttentionResult> {
  const { limit = 8, sinceHours = 72 } = options;

  const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  const [ctx, inbox] = await Promise.all([
    buildContext(mail, me),
    mail.list({ folder: 'inbox', limit: 100, since }),
  ]);

  const scored = inbox.map((m) => scoreMessage(m, ctx)).sort((a, b) => b.score - a.score);
  const kept = scored.filter((m) => m.score > 20);

  return {
    items: kept.slice(0, limit),
    consideredCount: inbox.length,
    filteredOutCount: inbox.length - kept.length,
  };
}

export interface FollowUp {
  conversationId: string;
  subject: string;
  counterpart: string;
  lastMessageAt: string;
  daysWaiting: number;
  webLink: string;
}

export interface FollowUpsResult {
  /** She wrote last; the other side has not come back. */
  awaitingReply: FollowUp[];
  /** They wrote last; she has not come back. */
  owedByHer: FollowUp[];
}

/**
 * Derived by comparing sent and received threads. No model involved, so these
 * are facts rather than guesses — and they resolve themselves the moment
 * someone replies.
 */
export async function findFollowUps(
  mail: MailService,
  me: string,
  options: { minDays?: number; limit?: number } = {},
): Promise<FollowUpsResult> {
  const { minDays = 3, limit = 10 } = options;

  const [sent, inbox] = await Promise.all([
    mail.list({ folder: 'sentitems', limit: 100 }),
    mail.list({ folder: 'inbox', limit: 100 }),
  ]);

  const lastSent = new Map<string, MailMessage>();
  for (const m of sent) {
    if (!m.conversationId) continue;
    const existing = lastSent.get(m.conversationId);
    if (!existing || m.sentAt > existing.sentAt) lastSent.set(m.conversationId, m);
  }

  const lastReceived = new Map<string, MailMessage>();
  for (const m of inbox) {
    if (!m.conversationId) continue;
    const existing = lastReceived.get(m.conversationId);
    if (!existing || m.receivedAt > existing.receivedAt) lastReceived.set(m.conversationId, m);
  }

  const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

  const awaitingReply: FollowUp[] = [];
  for (const [conversationId, msg] of lastSent) {
    const reply = lastReceived.get(conversationId);
    if (reply && reply.receivedAt > msg.sentAt) continue; // they came back

    const waiting = days(msg.sentAt);
    if (waiting < minDays) continue;

    const to = msg.toRecipients[0];
    awaitingReply.push({
      conversationId,
      subject: msg.subject,
      counterpart: to ? `${to.name} <${to.address}>` : 'unknown recipient',
      lastMessageAt: msg.sentAt,
      daysWaiting: waiting,
      webLink: msg.webLink,
    });
  }

  const owedByHer: FollowUp[] = [];
  for (const [conversationId, msg] of lastReceived) {
    if (looksAutomated(msg)) continue;

    const mine = lastSent.get(conversationId);
    if (mine && mine.sentAt > msg.receivedAt) continue; // she already replied

    const addressedDirectly = msg.toRecipients.some((r) => r.address === me);
    if (!addressedDirectly) continue;

    const waiting = days(msg.receivedAt);
    if (waiting < minDays) continue;

    owedByHer.push({
      conversationId,
      subject: msg.subject,
      counterpart: msg.from ? `${msg.from.name} <${msg.from.address}>` : 'unknown sender',
      lastMessageAt: msg.receivedAt,
      daysWaiting: waiting,
      webLink: msg.webLink,
    });
  }

  const byWait = (a: FollowUp, b: FollowUp) => b.daysWaiting - a.daysWaiting;
  return {
    awaitingReply: awaitingReply.sort(byWait).slice(0, limit),
    owedByHer: owedByHer.sort(byWait).slice(0, limit),
  };
}
