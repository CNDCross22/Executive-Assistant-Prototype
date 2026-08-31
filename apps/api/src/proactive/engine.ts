import type { StoredUser } from '../auth/store.js';
import type { DashboardData } from '../dashboard/service.js';
import type { CalendarEvent } from '../graph/calendar.service.js';
import { recordTelemetry } from '../observability/telemetry.js';
import { detectProactiveEvents } from './detectors.js';
import { isQuietHours, localDay, meetsThreshold } from './policy.js';
import { proactiveStore, type ProactiveStore } from './store.js';
import { PROACTIVE_EVENT_TYPES, type ProactiveEvent, type ProactiveNotification, type ProactivePolicy, type ProactiveScanResult } from './types.js';

export type PublicProactiveNotification = Pick<ProactiveNotification, 'id' | 'status' | 'outcome' | 'shownAt' | 'acknowledgedAt' | 'snoozedUntil' | 'lastNotifiedAt'> & {
  event: Pick<ProactiveEvent, 'type' | 'severity' | 'confidence' | 'title' | 'summary' | 'recommendation' | 'evidence' | 'actionLink' | 'effectiveAt' | 'expiresAt'>;
};

export type PublicProactivePolicy = Omit<ProactivePolicy, 'id' | 'userId'>;

export interface ProactiveInbox {
  notifications: PublicProactiveNotification[];
  unreadCount: number;
  policies: PublicProactivePolicy[];
  diagnostics: { lastRun: ProactiveScanResult | null };
}

const queuedScans = new Map<string, Promise<void>>();

/** Keep dashboard-triggered scans off the response path and prevent overlap. */
export function queueProactiveScan(userId: string, task: () => Promise<unknown>, onError: (error: unknown) => void): boolean {
  if (queuedScans.has(userId)) return false;
  const running = task().then(() => undefined).catch(onError).finally(() => queuedScans.delete(userId));
  queuedScans.set(userId, running);
  return true;
}

export async function scanProactiveSnapshot(input: {
  user: StoredUser;
  dashboard: DashboardData;
  calendar?: CalendarEvent[];
  degradedSources?: string[];
  requestId?: string;
  now?: Date;
  deliveryMode?: 'observe' | 'notify';
  store?: ProactiveStore;
  telemetry?: boolean;
}): Promise<ProactiveScanResult> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const store = input.store ?? proactiveStore();
  const deliveryMode = input.deliveryMode ?? 'notify';
  const policies = await store.policies(input.user.id, input.user.timezone);
  const byType = new Map(policies.map((policy) => [policy.eventType, policy]));
  const detected = detectProactiveEvents({
    userId: input.user.id, timezone: input.user.timezone, dashboard: input.dashboard,
    calendar: input.calendar ?? [], now,
  });

  let notified = 0;
  let observed = 0;
  let suppressed = 0;
  const activeKeys = new Set(detected.map((event) => event.dedupeKey));

  for (const candidate of detected) {
    const policy = byType.get(candidate.type);
    let decision: ProactiveEvent['policyDecision'];
    if (!policy?.enabled) decision = 'disabled';
    else if (!meetsThreshold(candidate as ProactiveEvent, policy)) decision = 'below_threshold';
    else if (deliveryMode === 'observe') decision = 'observe';
    else decision = policy.outcome;

    if (decision === 'disabled' || decision === 'below_threshold' || decision === 'observe') {
      await store.upsertEvent(candidate, 'observed', decision, now);
      observed++;
      continue;
    }

    const saved = await store.upsertEvent(candidate, 'active', decision, now);
    const needsPolicyGate = saved.isNew || saved.versionChanged || saved.previousStatus === 'observed';

    if (needsPolicyGate && isQuietHours(now, policy!)) {
      await store.upsertEvent(candidate, saved.isNew ? 'observed' : 'active', 'quiet_hours', now);
      suppressed++;
      continue;
    }

    const day = localDay(now, policy!.timezone);
    const deliveredToday = await store.notificationCount(input.user.id, day, candidate.type);
    if ((saved.isNew || saved.previousStatus === 'observed') && deliveredToday >= policy!.dailyCap) {
      await store.upsertEvent(candidate, 'observed', 'daily_cap', now);
      suppressed++;
      continue;
    }

    if (await store.notify(saved.event, policy!.outcome, day, policy!.cooldownMinutes, now)) notified++;
  }

  const resolved = await store.resolveMissing(input.user.id, activeKeys, [...PROACTIVE_EVENT_TYPES], now);
  const result: ProactiveScanResult = {
    scannedAt: now.toISOString(), detected: detected.length, notified, observed, suppressed, resolved,
    degradedSources: [...new Set(input.degradedSources ?? [])], deliveryMode,
  };
  await store.recordRun(input.user.id, result);
  if (input.telemetry !== false) {
    await recordTelemetry({
      category: 'proactive', action: 'generated', status: 'success',
      userId: input.user.id, requestId: input.requestId, purpose: 'proactive_scan', count: detected.length,
      durationMs: Date.now() - started, reasonCode: result.degradedSources.length ? 'partial_sources' : 'deterministic',
    });
  }
  return result;
}

export async function proactiveInbox(userId: string, timezone: string, store: ProactiveStore = proactiveStore()): Promise<ProactiveInbox> {
  const [notifications, policies, diagnostics] = await Promise.all([
    store.notifications(userId), store.policies(userId, timezone), store.diagnostics(userId),
  ]);
  const publicNotifications: PublicProactiveNotification[] = notifications.map((row) => ({
    id: row.id, status: row.status, outcome: row.outcome, shownAt: row.shownAt, acknowledgedAt: row.acknowledgedAt,
    snoozedUntil: row.snoozedUntil, lastNotifiedAt: row.lastNotifiedAt,
    event: {
      type: row.event.type, severity: row.event.severity, confidence: row.event.confidence, title: row.event.title,
      summary: row.event.summary, recommendation: row.event.recommendation, evidence: row.event.evidence,
      actionLink: row.event.actionLink, effectiveAt: row.event.effectiveAt, expiresAt: row.event.expiresAt,
    },
  }));
  const publicPolicies: PublicProactivePolicy[] = policies.map(({ id: _id, userId: _userId, ...policy }) => policy);
  return { notifications: publicNotifications, unreadCount: publicNotifications.filter((row) => row.status === 'unread').length, policies: publicPolicies, diagnostics };
}
