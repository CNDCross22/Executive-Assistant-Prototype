import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../dashboard/service.js';
import { needsAttentionFrom, followUpsFrom, type MailSnapshot } from '../mail/triage.js';
import type { MailMessage, MailService } from '../graph/mail.service.js';

/**
 * The dashboard used to fetch Sent twice and Inbox three times on every
 * build, and it rebuilds while a browser tab is open. Nothing failed, so
 * nothing surfaced it — the cost was invisible in Graph quota and latency.
 *
 * These tests count the reads. Ranking correctness is covered elsewhere; what
 * is pinned here is how many times we go to Microsoft to do it.
 */

const ME = 'director@example.com';

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1', conversationId: 'c1', subject: 'Subject',
    from: { name: 'Sender', address: 'sender@example.com' },
    toRecipients: [{ name: 'Director', address: ME }],
    ccRecipients: [], bccRecipients: [],
    receivedAt: new Date().toISOString(), sentAt: new Date().toISOString(),
    isRead: false, hasAttachments: false, importance: 'normal',
    bodyPreview: 'Please approve the revised contract.', webLink: '', isExternal: true,
    ...overrides,
  };
}

/** A mail service that records which folders were read. */
function countingMail(): { mail: MailService; reads: string[] } {
  const reads: string[] = [];
  const mail = {
    async list(options: { folder?: string } = {}) {
      const folder = options.folder ?? 'inbox';
      reads.push(folder);
      return folder === 'sentitems'
        ? [message({ id: 's1', conversationId: 'c9', sentAt: new Date(Date.now() - 5 * 86_400_000).toISOString() })]
        : [message()];
    },
  } as unknown as MailService;
  return { mail, reads };
}

describe('Dashboard read cost', () => {
  test('one build reads each folder exactly once', async () => {
    const { mail, reads } = countingMail();
    await buildDashboard(mail, ME, 'user-1');

    assert.equal(reads.filter((f) => f === 'inbox').length, 1, 'Inbox was read more than once');
    assert.equal(reads.filter((f) => f === 'sentitems').length, 1, 'Sent was read more than once');
    assert.equal(reads.length, 2, `expected 2 folder reads, saw ${reads.length}: ${reads.join(', ')}`);
  });

  test('the dashboard still reports what it used to', async () => {
    const { mail } = countingMail();
    const data = await buildDashboard(mail, ME, 'user-1');

    assert.ok(Array.isArray(data.needsYou));
    assert.ok(Array.isArray(data.inbox.messages));
    assert.equal(data.inbox.unreadCount, 1);
    assert.ok(data.generatedAt);
  });
});

describe('Ranking from a shared snapshot', () => {
  const snapshot: MailSnapshot = {
    inbox: [
      message({ id: 'recent', receivedAt: new Date().toISOString() }),
      message({ id: 'old', receivedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }),
    ],
    sent: [message({ id: 'sent', conversationId: 'c-sent', sentAt: new Date(Date.now() - 9 * 86_400_000).toISOString() })],
  };

  test('the lookback window is applied in memory, not by refetching', () => {
    const recent = needsAttentionFrom(snapshot, ME, { sinceHours: 72 });
    const wide = needsAttentionFrom(snapshot, ME, { sinceHours: 24 * 365 });

    assert.equal(recent.consideredCount, 1, 'the 30-day-old message should fall outside 72 hours');
    assert.equal(wide.consideredCount, 2, 'a wider window should reach it from the same snapshot');
  });

  test('follow-ups derive from the same snapshot without another read', () => {
    const result = followUpsFrom(snapshot, ME, { minDays: 3 });
    assert.ok(Array.isArray(result.awaitingReply));
    assert.ok(Array.isArray(result.owedByHer));
    // Sent 9 days ago with no reply in that thread.
    assert.equal(result.awaitingReply.some((item) => item.daysWaiting >= 3), true);
  });
});
