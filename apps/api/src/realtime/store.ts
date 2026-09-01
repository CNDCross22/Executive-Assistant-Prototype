/**
 * Persistence for real-time mail state.
 *
 * Two things live here: the Graph subscriptions we hold, and the delta cursor
 * that lets reconciliation read only what changed. Both fall back to memory so
 * the app still starts before the database exists, matching every other store
 * in the codebase — but real-time delivery is disabled without a database,
 * because a subscription that outlives the process that made it and cannot be
 * found again is worse than no subscription at all.
 */
import { hasDb, requireDb } from '../db/index.js';
import { hashToken } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

export type SubscriptionStatus = 'active' | 'expired' | 'revoked' | 'failed';

export interface StoredSubscription {
  id: string;
  userId: string;
  subscriptionId: string;
  resource: string;
  changeType: string;
  clientStateHash: string;
  notificationUrl: string;
  expiresAt: string;
  status: SubscriptionStatus;
  renewalFailures: number;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  subscription_id: string;
  resource: string;
  change_type: string;
  client_state_hash: string;
  notification_url: string;
  expires_at: Date;
  status: SubscriptionStatus;
  renewal_failures: number;
}

function fromRow(row: SubscriptionRow): StoredSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    resource: row.resource,
    changeType: row.change_type,
    clientStateHash: row.client_state_hash,
    notificationUrl: row.notification_url,
    expiresAt: row.expires_at.toISOString(),
    status: row.status,
    renewalFailures: row.renewal_failures,
  };
}

const COLUMNS = 'id, user_id, subscription_id, resource, change_type, client_state_hash, notification_url, expires_at, status, renewal_failures';

/** Hash a clientState for storage and comparison. The secret itself is never kept. */
export function clientStateHash(value: string): string {
  return hashToken(value);
}

export async function recordSubscription(input: {
  userId: string;
  subscriptionId: string;
  resource: string;
  changeType: string;
  clientState: string;
  notificationUrl: string;
  expiresAt: string;
}): Promise<void> {
  if (!hasDb()) return;
  const db = requireDb();

  // Retire any earlier subscription for this resource first. Two live
  // subscriptions would deliver every message twice.
  await db`
    update graph_subscriptions set status = 'revoked'
    where user_id = ${input.userId} and resource = ${input.resource} and status = 'active'
  `;

  await db`
    insert into graph_subscriptions
      (user_id, subscription_id, resource, change_type, client_state_hash, notification_url, expires_at)
    values (
      ${input.userId}, ${input.subscriptionId}, ${input.resource}, ${input.changeType},
      ${clientStateHash(input.clientState)}, ${input.notificationUrl}, ${input.expiresAt}
    )
    on conflict (subscription_id) do update set
      status = 'active', expires_at = excluded.expires_at,
      client_state_hash = excluded.client_state_hash, renewal_failures = 0
  `;
}

/** Look up a live subscription by the id Microsoft sent us. */
export async function findSubscription(subscriptionId: string): Promise<StoredSubscription | null> {
  if (!hasDb()) return null;
  const db = requireDb();
  const rows = await db<SubscriptionRow[]>`
    select ${db.unsafe(COLUMNS)} from graph_subscriptions
    where subscription_id = ${subscriptionId} and status = 'active'
    limit 1
  `;
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function activeSubscriptionFor(userId: string, resource: string): Promise<StoredSubscription | null> {
  if (!hasDb()) return null;
  const db = requireDb();
  const rows = await db<SubscriptionRow[]>`
    select ${db.unsafe(COLUMNS)} from graph_subscriptions
    where user_id = ${userId} and resource = ${resource} and status = 'active'
    limit 1
  `;
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Subscriptions close enough to expiry that they should be renewed now. */
export async function subscriptionsDueForRenewal(withinMinutes = 1_440): Promise<StoredSubscription[]> {
  if (!hasDb()) return [];
  const db = requireDb();
  const rows = await db<SubscriptionRow[]>`
    select ${db.unsafe(COLUMNS)} from graph_subscriptions
    where status = 'active'
      and expires_at <= now() + make_interval(mins => ${withinMinutes})
    order by expires_at asc
    limit 200
  `;
  return rows.map(fromRow);
}

export async function markRenewed(subscriptionId: string, expiresAt: string): Promise<void> {
  if (!hasDb()) return;
  const db = requireDb();
  await db`
    update graph_subscriptions
    set expires_at = ${expiresAt}, last_renewed_at = now(), renewal_failures = 0, status = 'active'
    where subscription_id = ${subscriptionId}
  `;
}

export async function markSubscriptionStatus(
  subscriptionId: string,
  status: SubscriptionStatus,
  countFailure = false,
): Promise<void> {
  if (!hasDb()) return;
  const db = requireDb();
  await db`
    update graph_subscriptions
    set status = ${status},
        renewal_failures = renewal_failures + ${countFailure ? 1 : 0}
    where subscription_id = ${subscriptionId}
  `;
}

export async function touchNotified(subscriptionId: string): Promise<void> {
  if (!hasDb()) return;
  try {
    const db = requireDb();
    await db`update graph_subscriptions set last_notified_at = now() where subscription_id = ${subscriptionId}`;
  } catch (err) {
    // Bookkeeping must never cost us a notification.
    logger.debug({ err, subscriptionId }, 'Could not record notification timestamp');
  }
}

// ---------------------------------------------------------- delta cursors ---

export async function readDeltaLink(userId: string, folder = 'inbox'): Promise<string | null> {
  if (!hasDb()) return null;
  const db = requireDb();
  const rows = await db<{ delta_link: string | null }[]>`
    select delta_link from mail_delta_cursors
    where user_id = ${userId} and folder = ${folder} limit 1
  `;
  return rows[0]?.delta_link ?? null;
}

export async function writeDeltaLink(userId: string, folder: string, deltaLink: string | null): Promise<void> {
  if (!hasDb()) return;
  const db = requireDb();
  await db`
    insert into mail_delta_cursors (user_id, folder, delta_link, last_synced_at, last_error)
    values (${userId}, ${folder}, ${deltaLink}, now(), null)
    on conflict (user_id, folder) do update set
      delta_link = excluded.delta_link, last_synced_at = now(), last_error = null
  `;
}

export async function recordDeltaError(userId: string, folder: string, detail: string): Promise<void> {
  if (!hasDb()) return;
  try {
    const db = requireDb();
    await db`
      insert into mail_delta_cursors (user_id, folder, last_error)
      values (${userId}, ${folder}, ${detail.slice(0, 300)})
      on conflict (user_id, folder) do update set last_error = excluded.last_error
    `;
  } catch (err) {
    logger.debug({ err, userId }, 'Could not record delta error');
  }
}
