/**
 * Microsoft Graph change-notification subscriptions.
 *
 * A subscription is the only way Hermes learns about mail without asking. It
 * is also a standing instruction to an external service to call us, so the
 * rules are strict:
 *
 *   - The notification URL must be public HTTPS. We refuse to create a
 *     subscription pointing anywhere else rather than create one that silently
 *     never fires.
 *   - clientState is a fresh random secret per subscription. Only its hash is
 *     stored, and every incoming notification is checked against that hash.
 *   - Mail subscriptions expire in under three days. Renewal is a scheduled
 *     job, and a lapsed subscription degrades to the reconciliation sweep
 *     rather than losing mail.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import type { GraphClient } from '../graph/client.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import {
  activeSubscriptionFor,
  markRenewed,
  markSubscriptionStatus,
  recordSubscription,
  type StoredSubscription,
} from './store.js';

/** The inbox message collection. Narrower than the whole mailbox on purpose. */
export const INBOX_RESOURCE = "/me/mailFolders('inbox')/messages";

/**
 * Microsoft caps message subscriptions at 4230 minutes. Ask for slightly less
 * so a clock difference between us and Graph cannot make the request invalid.
 */
const MAX_LIFETIME_MINUTES = 4_200;

interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  expirationDateTime: string;
  notificationUrl: string;
}

/** Where Microsoft should send notifications, or null when that is not possible. */
export function notificationUrl(): string | null {
  const configured = env.HERMES_WEBHOOK_URL ?? `${env.API_URL}/api/graph/notifications`;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  // Graph will not deliver to plain HTTP, and will not resolve a private host.
  if (url.protocol !== 'https:') return null;
  if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return null;
  return url.toString();
}

export function realtimeAvailable(): boolean {
  return notificationUrl() !== null;
}

function expiry(): string {
  return new Date(Date.now() + MAX_LIFETIME_MINUTES * 60_000).toISOString();
}

/**
 * Create (or replace) the inbox subscription for one user.
 *
 * Returns null when real-time delivery is not configured, so callers can carry
 * on with polling instead of failing. That is a normal state in development.
 */
export async function subscribeToInbox(
  userId: string,
  graph: GraphClient,
): Promise<StoredSubscription | null> {
  const url = notificationUrl();
  if (!url) {
    logger.info({ userId }, 'Real-time mail is unavailable: no public HTTPS notification URL');
    return null;
  }

  const existing = await activeSubscriptionFor(userId, INBOX_RESOURCE);
  // Still comfortably alive and pointing at the right place: leave it be.
  if (existing && existing.notificationUrl === url && Date.parse(existing.expiresAt) > Date.now() + 36 * 3_600_000) {
    return existing;
  }

  const clientState = crypto.randomBytes(32).toString('base64url');
  const created = await graph.request<GraphSubscription>('/subscriptions', {
    method: 'POST',
    body: {
      changeType: 'created',
      notificationUrl: url,
      resource: INBOX_RESOURCE,
      expirationDateTime: expiry(),
      clientState,
      latestSupportedTlsVersion: 'v1_2',
    },
    label: 'subscriptions.create',
    retry: 'never',
  });

  await recordSubscription({
    userId,
    subscriptionId: created.id,
    resource: INBOX_RESOURCE,
    changeType: created.changeType ?? 'created',
    clientState,
    notificationUrl: url,
    expiresAt: created.expirationDateTime ?? expiry(),
  });

  logger.info({ userId, subscriptionId: created.id, expiresAt: created.expirationDateTime }, 'Inbox subscription created');
  return activeSubscriptionFor(userId, INBOX_RESOURCE);
}

/** Extend one subscription. Returns false when Microsoft has already dropped it. */
export async function renewSubscription(
  subscription: StoredSubscription,
  graph: GraphClient,
): Promise<boolean> {
  try {
    const renewed = await graph.request<GraphSubscription>(`/subscriptions/${subscription.subscriptionId}`, {
      method: 'PATCH',
      body: { expirationDateTime: expiry() },
      label: 'subscriptions.renew',
      retry: 'safe',
    });
    await markRenewed(subscription.subscriptionId, renewed.expirationDateTime ?? expiry());
    return true;
  } catch (err) {
    // A 404 means Microsoft has forgotten it; there is nothing to extend and
    // the next sign-in or scheduled pass will create a fresh one.
    const gone = err instanceof AppError && err.statusCode === 404;
    await markSubscriptionStatus(subscription.subscriptionId, gone ? 'expired' : 'active', !gone);
    logger.warn(
      { subscriptionId: subscription.subscriptionId, userId: subscription.userId, gone, err },
      'Could not renew inbox subscription',
    );
    return false;
  }
}

export async function unsubscribe(subscription: StoredSubscription, graph: GraphClient): Promise<void> {
  try {
    await graph.request(`/subscriptions/${subscription.subscriptionId}`, {
      method: 'DELETE',
      label: 'subscriptions.delete',
      retry: 'never',
    });
  } catch (err) {
    // Already gone is a success for our purposes.
    logger.debug({ err, subscriptionId: subscription.subscriptionId }, 'Subscription delete did not confirm');
  }
  await markSubscriptionStatus(subscription.subscriptionId, 'revoked');
}
