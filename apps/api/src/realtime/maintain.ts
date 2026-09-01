/**
 * Keeps real-time mail alive, and catches anything it dropped.
 *
 * Two jobs, deliberately in one pass so they cannot drift apart:
 *
 *   RENEW        Mail subscriptions expire in under three days. Anything
 *                inside the renewal window is extended; anything Microsoft has
 *                already forgotten is recreated.
 *
 *   RECONCILE    A push channel that is 99.9% reliable still loses a message
 *                eventually. Every pass reads the inbox delta for each
 *                connected user, and if anything arrived that we never got a
 *                notification for, it triggers the same deterministic scan the
 *                webhook would have.
 *
 * Run from a schedule (see .github/workflows/maintenance.yml):
 *
 *   npm run realtime:maintain
 *
 * No model is called anywhere in this file.
 */
import { authStore } from '../auth/store.js';
import { getAccessToken } from '../auth/msal.js';
import { ownDomainOf } from '../auth/session.js';
import { GraphClient } from '../graph/client.js';
import { MailService } from '../graph/mail.service.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { runScanForUser } from './notifications.js';
import {
  activeSubscriptionFor,
  readDeltaLink,
  recordDeltaError,
  subscriptionsDueForRenewal,
  writeDeltaLink,
} from './store.js';
import { INBOX_RESOURCE, realtimeAvailable, renewSubscription, subscribeToInbox } from './subscriptions.js';

export interface MaintenanceReport {
  renewed: number;
  recreated: number;
  renewalFailures: number;
  reconciled: number;
  newMailFound: number;
  skipped: number;
}

async function graphFor(userId: string, homeAccountId: string): Promise<GraphClient> {
  const token = await getAccessToken(userId, homeAccountId);
  return new GraphClient(token, { userId, requestId: `maintain:${crypto.randomUUID()}` });
}

export async function maintainRealtime(options: { reconcile?: boolean } = {}): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    renewed: 0, recreated: 0, renewalFailures: 0, reconciled: 0, newMailFound: 0, skipped: 0,
  };

  if (!realtimeAvailable()) {
    logger.warn('Real-time mail is not configured (no public HTTPS notification URL); nothing to maintain.');
    return report;
  }

  // ------------------------------------------------------------- renew ---

  const due = await subscriptionsDueForRenewal();
  for (const subscription of due) {
    try {
      const connection = await authStore().getConnection(subscription.userId);
      if (!connection || connection.status !== 'connected') {
        report.skipped++;
        continue;
      }
      const graph = await graphFor(subscription.userId, connection.homeAccountId);
      const extended = await renewSubscription(subscription, graph);
      if (extended) {
        report.renewed++;
      } else {
        // Microsoft dropped it. Make a new one rather than leaving the user
        // silently back on polling.
        const created = await subscribeToInbox(subscription.userId, graph);
        if (created) report.recreated++;
        else report.renewalFailures++;
      }
    } catch (err) {
      report.renewalFailures++;
      if (err instanceof AppError && err.code === 'needs_reauth') {
        await authStore().markNeedsReauth(subscription.userId);
      }
      logger.warn({ err, userId: subscription.userId }, 'Subscription maintenance failed for a user');
    }
  }

  if (options.reconcile === false) return report;

  // --------------------------------------------------------- reconcile ---

  const connected = await authStore().listConnectedUsers();
  for (const { user, connection } of connected) {
    try {
      const graph = await graphFor(user.id, connection.homeAccountId);

      // Anyone connected but without a live subscription gets one. This is how
      // users who signed in before real-time existed are brought in.
      const existing = await activeSubscriptionFor(user.id, INBOX_RESOURCE);
      if (!existing) {
        const created = await subscribeToInbox(user.id, graph);
        if (created) report.recreated++;
      }

      const mail = new MailService(graph, ownDomainOf(user.email));
      const cursor = await readDeltaLink(user.id, 'inbox');
      const result = await mail.delta({ folder: 'inbox', deltaLink: cursor });

      // Only persist a cursor Graph actually gave us. Storing nothing on a
      // partial read means the next pass re-reads rather than skips.
      if (result.deltaLink) await writeDeltaLink(user.id, 'inbox', result.deltaLink);
      report.reconciled++;

      // A first sync has no prior cursor, so everything looks new. Only treat
      // changes as missed mail once a baseline exists.
      const missed = cursor ? result.messages.filter((message) => !message.isRead) : [];
      if (missed.length > 0) {
        report.newMailFound += missed.length;
        logger.info({ userId: user.id, count: missed.length }, 'Reconciliation found mail the webhook missed');
        await runScanForUser(user.id);
      }
    } catch (err) {
      report.skipped++;
      const detail = err instanceof Error ? err.message : 'unknown error';
      await recordDeltaError(user.id, 'inbox', detail);
      if (err instanceof AppError && err.code === 'needs_reauth') {
        await authStore().markNeedsReauth(user.id);
      }
      logger.warn({ err, userId: user.id }, 'Reconciliation failed for a user');
    }
  }

  return report;
}
