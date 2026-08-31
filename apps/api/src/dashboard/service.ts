/**
 * The Director's dashboard.
 *
 * Everything here is deterministic — queries over her mailbox, no model. That
 * matters for two reasons: it renders in well under a second, and none of it
 * can be confidently wrong.
 *
 * The AI briefing is a SEPARATE endpoint (see briefing.ts) so the page is
 * useful even when the model is unreachable, out of budget, or slow.
 */
import type { MailService } from '../graph/mail.service.js';
import { needsAttention, findFollowUps, looksAutomated } from '../mail/triage.js';
import { assessSuspicion } from '../mail/suspicion.js';
import { listMemory } from '../memory/store.js';
import type { ExecutiveImpact, RecommendedAction } from '../mail/executive.js';

export interface DashboardItem {
  ref: string;
  /** Real Graph message id, for opening the message in the reading pane. */
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  unread: boolean;
  external: boolean;
  importance: 'low' | 'normal' | 'high';
  reasons: string[];
  priorityScore: number;
  deterministicScore: number;
  executiveAdjustment: number;
  request: string | null;
  decisionRequired: boolean;
  statedDeadline: { statedText: string; evidence: string; parsedDate?: string } | null;
  consequence: string | null;
  impacts: ExecutiveImpact[];
  recommendation: { action: RecommendedAction; reason: string };
  hasUninspectedAttachments: boolean;
  preview: string;
  /** Set when the message looks like phishing or a prompt-injection attempt. */
  warning?: string;
  webLink: string;
}

export interface FollowUpItem {
  conversationId?: string;
  person: string;
  subject: string;
  lastMessageAt?: string;
  daysWaiting: number;
  webLink: string;
}

export interface DashboardData {
  generatedAt: string;
  needsYou: DashboardItem[];
  owedByYou: FollowUpItem[];
  waitingOnThem: FollowUpItem[];
  inbox: {
    unreadCount: number;
    receivedToday: number;
    filteredOut: number;
    considered: number;
  };
  /** Preferences the assistant wants to confirm before believing them. */
  pendingProposals: { id: string; title: string; content: string }[];
}

export async function buildDashboard(
  mail: MailService,
  me: string,
  userId: string,
): Promise<DashboardData> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [attention, followUps, unread, today, memory] = await Promise.all([
    needsAttention(mail, me, { limit: 6, sinceHours: 72 }),
    findFollowUps(mail, me, { minDays: 3, limit: 5 }),
    mail.list({ limit: 100, unreadOnly: true }).catch(() => []),
    mail.list({ limit: 100, since: startOfToday.toISOString() }).catch(() => []),
    listMemory(userId).catch(() => []),
  ]);

  const needsYou: DashboardItem[] = attention.items.map((m, i) => {
    const suspicion = assessSuspicion([m.subject, m.bodyPreview].join(' '), m.from?.address);
    return {
      ref: `d${i + 1}`,
      id: m.id,
      from: m.from?.name ?? 'Unknown sender',
      fromEmail: m.from?.address ?? '',
      subject: m.subject,
      receivedAt: m.receivedAt,
      unread: !m.isRead,
      external: m.isExternal,
      importance: m.importance,
      reasons: m.reasons,
      priorityScore: m.score,
      deterministicScore: m.deterministicScore,
      executiveAdjustment: m.executiveAdjustment,
      request: m.executive.request,
      decisionRequired: m.executive.decisionRequired,
      statedDeadline: m.executive.deadline,
      consequence: m.executive.consequence,
      impacts: m.executive.impacts,
      recommendation: m.executive.recommendation,
      hasUninspectedAttachments: m.hasAttachments,
      preview: m.bodyPreview.slice(0, 180),
      ...(suspicion.suspicious
        ? { warning: 'This looks like a phishing or prompt-injection attempt. Nothing has been acted on.' }
        : {}),
      webLink: m.webLink,
    };
  });

  const shape = (f: { conversationId: string; counterpart: string; subject: string; lastMessageAt: string; daysWaiting: number; webLink: string }): FollowUpItem => ({
    conversationId: f.conversationId,
    person: f.counterpart.replace(/\s*<[^>]+>$/, '').trim() || f.counterpart,
    subject: f.subject,
    lastMessageAt: f.lastMessageAt,
    daysWaiting: f.daysWaiting,
    webLink: f.webLink,
  });

  return {
    generatedAt: new Date().toISOString(),
    needsYou,
    owedByYou: followUps.owedByHer.map(shape),
    waitingOnThem: followUps.awaitingReply.map(shape),
    inbox: {
      unreadCount: unread.length,
      receivedToday: today.filter((m) => !looksAutomated(m)).length,
      filteredOut: attention.filteredOutCount,
      considered: attention.consideredCount,
    },
    pendingProposals: memory
      .filter((m) => m.status === 'proposed')
      .slice(0, 3)
      .map((m) => ({ id: m.id, title: m.title, content: m.content })),
  };
}
