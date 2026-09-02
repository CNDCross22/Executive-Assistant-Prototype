/**
 * From a Graph notification to an in-app notice, deterministically.
 *
 * The rule that shapes this file: no model call may ever happen on this path.
 * New mail must reach the Director in seconds, and a paid reasoning model is
 * both too slow and too expensive to sit between a message arriving and a
 * notice appearing. Everything here runs the existing rules layer — triage
 * scoring, suspicion assessment, the proactive detectors — all of which are
 * plain queries and regular expressions.
 *
 * A notification is a hint, not data. It carries an id and a change type; the
 * message is read with the user's own delegated token, and nothing in the
 * notification body is trusted beyond matching it to a subscription we made.
 */
import { authStore } from '../auth/store.js';
import { getAccessToken } from '../auth/msal.js';
import { env } from '../config/env.js';
import { GraphClient } from '../graph/client.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { recordTelemetry } from '../observability/telemetry.js';
import { queueProactiveScan } from '../proactive/engine.js';
import { runProactiveRead } from '../proactive/runner.js';
import { clientStateHash, findSubscription, touchNotified } from './store.js';

/** One notification as Microsoft sends it. Everything is optional and untrusted. */
export interface GraphChangeNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
  subscriptionExpirationDateTime?: string;
}

/**
 * Coalescing window.
 *
 * Ten messages arriving together should produce one scan, not ten. A short
 * window keeps perceived latency well inside the fifteen-second target while
 * collapsing a burst into a single pass over the mailbox.
 */
const COALESCE_MS = 4_000;

/** Floor between scans for one user, so a busy mailbox cannot spin. */
const MIN_INTERVAL_MS = 20_000;

const pendingScan = new Map<string, ReturnType<typeof setTimeout>>();
const lastScanAt = new Map<string, number>();

/** Constant-time comparison of the echoed clientState against the stored hash. */
export function clientStateMatches(received: string | undefined, expectedHash: string): boolean {
  if (!received) return false;
  const actual = clientStateHash(received);
  if (actual.length !== expectedHash.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) {
    difference |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Validate a batch and return the users whose mailbox should be re-read.
 *
 * Rejected notifications are counted, never thrown: Microsoft retries on a
 * non-2xx, and retrying a notification we have already decided is invalid
 * achieves nothing except more of them.
 */
export async function acceptNotifications(
  batch: GraphChangeNotification[],
): Promise<{ accepted: string[]; rejected: number; unavailable: boolean }> {
  const accepted = new Set<string>();
  let rejected = 0;
  let unavailable = false;

  for (const notification of batch) {
    const subscriptionId = notification.subscriptionId;
    if (!subscriptionId) {
      rejected++;
      continue;
    }

    let subscription: Awaited<ReturnType<typeof findSubscription>>;
    try {
      subscription = await findSubscription(subscriptionId);
    } catch (err) {
      // We cannot tell a forged notification from a real one while the store
      // is unreachable. Say so, so the caller can ask Microsoft to retry
      // rather than silently dropping mail we were told about.
      unavailable = true;
      logger.error({ err, subscriptionId }, 'Could not verify a notification: subscription store unavailable');
      continue;
    }

    if (!subscription) {
      rejected++;
      logger.warn({ subscriptionId }, 'Notification for an unknown subscription');
      continue;
    }

    if (!clientStateMatches(notification.clientState, subscription.clientStateHash)) {
      rejected++;
      logger.error({ subscriptionId }, 'Notification failed clientState verification');
      void recordTelemetry({
        category: 'security', action: 'untrusted_content_warning', status: 'failed',
        userId: subscription.userId, reasonCode: 'notification_client_state_mismatch',
      });
      continue;
    }

    accepted.add(subscription.userId);
    void touchNotified(subscriptionId);
  }

  return { accepted: [...accepted], rejected, unavailable };
}

/**
 * Schedule a deterministic re-read for one user.
 *
 * Deliberately fire-and-forget. The webhook must acknowledge Microsoft
 * quickly; doing the work inside the request would risk a timeout and a
 * pointless retry.
 */
export function scheduleScan(userId: string): void {
  if (pendingScan.has(userId)) return;

  const since = Date.now() - (lastScanAt.get(userId) ?? 0);
  const delay = since >= MIN_INTERVAL_MS ? COALESCE_MS : Math.max(COALESCE_MS, MIN_INTERVAL_MS - since);

  const timer = setTimeout(() => {
    pendingScan.delete(userId);
    lastScanAt.set(userId, Date.now());
    void runScanForUser(userId);
  }, delay);

  // Never hold the process open for a scan that has not happened yet.
  timer.unref?.();
  pendingScan.set(userId, timer);
}

/** Read the mailbox and update proactive state. No model is involved. */
export async function runScanForUser(userId: string): Promise<void> {
  const started = Date.now();

  const queued = queueProactiveScan(userId, async () => {
    const user = await authStore().getUserById(userId);
    if (!user) return;

    const connection = await authStore().getConnection(userId);
    if (!connection || connection.status !== 'connected') return;

    const token = await getAccessToken(userId, connection.homeAccountId);
    const graph = new GraphClient(token, { userId, requestId: `realtime:${crypto.randomUUID()}` });

    await runProactiveRead(user, graph, { deliveryMode: env.HERMES_PROACTIVE_DELIVERY });

    void recordTelemetry({
      category: 'proactive', action: 'generated', status: 'success',
      userId, durationMs: Date.now() - started, reasonCode: 'realtime_notification',
    });
  }, (err) => {
    if (err instanceof AppError && err.code === 'needs_reauth') void authStore().markNeedsReauth(userId);
    logger.warn({ err, userId }, 'Real-time mail scan did not complete');
    void recordTelemetry({
      category: 'proactive', action: 'generated', status: 'failed',
      userId, durationMs: Date.now() - started, reasonCode: 'realtime_scan_failed',
    });
  });

  // A scan is already running for this user; its result will reflect the new
  // mail anyway, so there is nothing useful to do here.
  if (!queued) logger.debug({ userId }, 'Real-time scan skipped: one already running');
}

/** Test seam. Clears coalescing state between cases. */
export function resetScanScheduling(): void {
  for (const timer of pendingScan.values()) clearTimeout(timer);
  pendingScan.clear();
  lastScanAt.clear();
}
