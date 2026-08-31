import { hasDb, requireDb } from '../db/index.js';
import { Errors } from '../lib/errors.js';
import { defaultPolicy } from './policy.js';
import type {
  DetectedProactiveEvent, NotificationStatus, ProactiveEvent, ProactiveEventStatus,
  ProactiveEventType, ProactiveNotification, ProactiveOutcome, ProactivePolicy, ProactiveScanResult,
} from './types.js';

export interface StoredEventResult {
  event: ProactiveEvent;
  isNew: boolean;
  versionChanged: boolean;
  previousStatus: ProactiveEventStatus | null;
  previousDecision: ProactiveEvent['policyDecision'] | null;
}
export interface ProactiveDiagnostics { lastRun: ProactiveScanResult | null }

export interface ProactiveStore {
  policies(userId: string, timezone: string): Promise<ProactivePolicy[]>;
  updatePolicy(userId: string, eventType: ProactiveEventType, changes: Partial<Pick<ProactivePolicy, 'enabled' | 'outcome' | 'minimumSeverity' | 'quietStart' | 'quietEnd' | 'timezone' | 'cooldownMinutes' | 'dailyCap'>>): Promise<ProactivePolicy>;
  upsertEvent(input: DetectedProactiveEvent, status: ProactiveEventStatus, decision: ProactiveEvent['policyDecision'], now: Date): Promise<StoredEventResult>;
  resolveMissing(userId: string, activeKeys: Set<string>, scannedTypes: ProactiveEventType[], now: Date): Promise<number>;
  notificationCount(userId: string, localDay: string, eventType: ProactiveEventType): Promise<number>;
  notify(event: ProactiveEvent, outcome: ProactiveOutcome, localDay: string, cooldownMinutes: number, now: Date): Promise<boolean>;
  notifications(userId: string, limit?: number, now?: Date): Promise<ProactiveNotification[]>;
  setNotificationStatus(userId: string, id: string, status: Exclude<NotificationStatus, 'snoozed'>, now: Date): Promise<boolean>;
  snooze(userId: string, id: string, until: Date, now: Date): Promise<boolean>;
  recordRun(userId: string, result: ProactiveScanResult): Promise<void>;
  diagnostics(userId: string): Promise<ProactiveDiagnostics>;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class MemoryProactiveStore implements ProactiveStore {
  private readonly policyRows = new Map<string, ProactivePolicy>();
  private readonly eventRows = new Map<string, ProactiveEvent>();
  private readonly notificationRows = new Map<string, Omit<ProactiveNotification, 'event'> & { sourceVersion: string }>();
  private readonly runs = new Map<string, ProactiveScanResult>();

  private policyKey(userId: string, type: ProactiveEventType) { return `${userId}:${type}`; }

  async policies(userId: string, timezone: string): Promise<ProactivePolicy[]> {
    const types = (await import('./types.js')).PROACTIVE_EVENT_TYPES;
    for (const type of types) {
      const key = this.policyKey(userId, type);
      if (!this.policyRows.has(key)) this.policyRows.set(key, defaultPolicy(userId, type, timezone));
    }
    return [...this.policyRows.values()].filter((row) => row.userId === userId).map(clone);
  }

  async updatePolicy(userId: string, eventType: ProactiveEventType, changes: Parameters<ProactiveStore['updatePolicy']>[2]): Promise<ProactivePolicy> {
    await this.policies(userId, changes.timezone ?? 'UTC');
    const key = this.policyKey(userId, eventType);
    const current = this.policyRows.get(key)!;
    const updated = { ...current, ...changes, updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString() };
    this.policyRows.set(key, updated);
    return clone(updated);
  }

  async upsertEvent(input: DetectedProactiveEvent, status: ProactiveEventStatus, decision: ProactiveEvent['policyDecision'], now: Date): Promise<StoredEventResult> {
    const key = `${input.userId}:${input.dedupeKey}`;
    const existing = this.eventRows.get(key);
    const stamp = now.toISOString();
    const versionChanged = Boolean(existing && existing.sourceVersion !== input.sourceVersion);
    const event: ProactiveEvent = existing
      ? { ...existing, ...input, status, policyDecision: decision, lastSeenAt: stamp, updatedAt: stamp }
      : { ...input, id: crypto.randomUUID(), status, policyDecision: decision, firstDetectedAt: stamp, lastSeenAt: stamp, updatedAt: stamp };
    this.eventRows.set(key, event);
    return { event: clone(event), isNew: !existing, versionChanged, previousStatus: existing?.status ?? null, previousDecision: existing?.policyDecision ?? null };
  }

  async resolveMissing(userId: string, activeKeys: Set<string>, scannedTypes: ProactiveEventType[], now: Date): Promise<number> {
    let count = 0;
    for (const [key, event] of this.eventRows) {
      if (event.userId === userId && scannedTypes.includes(event.type) && event.status !== 'resolved' && !activeKeys.has(event.dedupeKey)) {
        this.eventRows.set(key, { ...event, status: 'resolved', updatedAt: now.toISOString() });
        count++;
      }
    }
    return count;
  }

  async notificationCount(userId: string, localDay: string, eventType: ProactiveEventType): Promise<number> {
    return [...this.notificationRows.values()].filter((row) => row.userId === userId && row.localDay === localDay && this.eventById(row.eventId)?.type === eventType).length;
  }

  private eventById(id: string): ProactiveEvent | undefined {
    return [...this.eventRows.values()].find((event) => event.id === id);
  }

  async notify(event: ProactiveEvent, outcome: ProactiveOutcome, day: string, cooldownMinutes: number, now: Date): Promise<boolean> {
    const existing = [...this.notificationRows.values()].find((row) => row.eventId === event.id);
    if (existing) {
      if (existing.sourceVersion === event.sourceVersion || existing.status === 'snoozed' && existing.snoozedUntil && Date.parse(existing.snoozedUntil) > now.getTime()) return false;
      if (now.getTime() - Date.parse(existing.lastNotifiedAt) < cooldownMinutes * 60_000) return false;
      this.notificationRows.set(existing.id, { ...existing, sourceVersion: event.sourceVersion, status: 'unread', outcome, localDay: day, acknowledgedAt: null, snoozedUntil: null, lastNotifiedAt: now.toISOString() });
      return true;
    }
    const id = crypto.randomUUID();
    this.notificationRows.set(id, { id, eventId: event.id, userId: event.userId, sourceVersion: event.sourceVersion, status: 'unread', outcome, localDay: day, shownAt: now.toISOString(), acknowledgedAt: null, snoozedUntil: null, lastNotifiedAt: now.toISOString() });
    return true;
  }

  async notifications(userId: string, limit = 20, now = new Date()): Promise<ProactiveNotification[]> {
    const result: ProactiveNotification[] = [];
    for (const [id, row] of this.notificationRows) {
      if (row.userId !== userId || row.status === 'dismissed') continue;
      let current = row;
      if (row.status === 'snoozed') {
        if (row.snoozedUntil && Date.parse(row.snoozedUntil) > now.getTime()) continue;
        current = { ...row, status: 'unread', snoozedUntil: null };
        this.notificationRows.set(id, current);
      }
      const event = this.eventById(row.eventId);
      if (!event || event.status !== 'active' || Date.parse(event.expiresAt) <= now.getTime()) continue;
      const { sourceVersion: _sourceVersion, ...notification } = current;
      result.push({ ...clone(notification), event: clone(event) });
    }
    const severity = { low: 0, normal: 1, high: 2, critical: 3 } as const;
    return result.sort((a, b) => severity[b.event.severity] - severity[a.event.severity] || b.lastNotifiedAt.localeCompare(a.lastNotifiedAt)).slice(0, limit);
  }

  async setNotificationStatus(userId: string, id: string, status: Exclude<NotificationStatus, 'snoozed'>, now: Date): Promise<boolean> {
    const row = this.notificationRows.get(id);
    if (!row || row.userId !== userId) return false;
    this.notificationRows.set(id, { ...row, status, acknowledgedAt: now.toISOString(), snoozedUntil: null });
    return true;
  }

  async snooze(userId: string, id: string, until: Date, now: Date): Promise<boolean> {
    const row = this.notificationRows.get(id);
    if (!row || row.userId !== userId) return false;
    this.notificationRows.set(id, { ...row, status: 'snoozed', acknowledgedAt: now.toISOString(), snoozedUntil: until.toISOString() });
    return true;
  }

  async recordRun(userId: string, result: ProactiveScanResult) { this.runs.set(userId, clone(result)); }
  async diagnostics(userId: string) { return { lastRun: clone(this.runs.get(userId) ?? null) }; }
}

type PolicyRow = {
  id: string; user_id: string; event_type: ProactiveEventType; enabled: boolean; outcome: ProactiveOutcome;
  minimum_severity: ProactivePolicy['minimumSeverity']; quiet_start: string | null; quiet_end: string | null;
  timezone: string; cooldown_minutes: number; daily_cap: number; confirmed_at: Date; updated_at: Date;
};

function policyFromRow(row: PolicyRow): ProactivePolicy {
  return { id: row.id, userId: row.user_id, eventType: row.event_type, enabled: row.enabled, outcome: row.outcome,
    minimumSeverity: row.minimum_severity, quietStart: row.quiet_start, quietEnd: row.quiet_end, timezone: row.timezone,
    cooldownMinutes: row.cooldown_minutes, dailyCap: row.daily_cap, confirmedAt: row.confirmed_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

type EventRow = {
  id: string; user_id: string; event_type: ProactiveEventType; dedupe_key: string; source_version: string; source_ref: string;
  severity: ProactiveEvent['severity']; confidence: number; title: string; summary: string; recommendation: string | null;
  evidence: string[]; action_link: string | null; effective_at: Date | null; expires_at: Date; status: ProactiveEventStatus;
  policy_decision: ProactiveEvent['policyDecision']; first_detected_at: Date; last_seen_at: Date; updated_at: Date;
};

function eventFromRow(row: EventRow): ProactiveEvent {
  return { id: row.id, userId: row.user_id, type: row.event_type, dedupeKey: row.dedupe_key, sourceVersion: row.source_version,
    sourceRef: row.source_ref, severity: row.severity, confidence: Number(row.confidence), title: row.title, summary: row.summary,
    recommendation: row.recommendation, evidence: row.evidence ?? [], actionLink: row.action_link,
    effectiveAt: row.effective_at?.toISOString() ?? null, expiresAt: row.expires_at.toISOString(), status: row.status,
    policyDecision: row.policy_decision, firstDetectedAt: row.first_detected_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export class PostgresProactiveStore implements ProactiveStore {
  async policies(userId: string, timezone: string): Promise<ProactivePolicy[]> {
    const db = requireDb();
    const { PROACTIVE_EVENT_TYPES } = await import('./types.js');
    const current = await db<PolicyRow[]>`select * from proactive_policies where user_id = ${userId} order by event_type`;
    if (current.length === PROACTIVE_EVENT_TYPES.length) return current.map(policyFromRow);
    const existing = new Set(current.map((row) => row.event_type));
    await Promise.all(PROACTIVE_EVENT_TYPES.filter((type) => !existing.has(type)).map(async (type) => {
      const value = defaultPolicy(userId, type, timezone);
      await db`insert into proactive_policies
        (id, user_id, event_type, enabled, outcome, minimum_severity, quiet_start, quiet_end, timezone, cooldown_minutes, daily_cap, confirmed_at)
        values (${value.id}, ${userId}, ${type}, ${value.enabled}, ${value.outcome}, ${value.minimumSeverity}, ${value.quietStart}, ${value.quietEnd}, ${value.timezone}, ${value.cooldownMinutes}, ${value.dailyCap}, ${value.confirmedAt})
        on conflict (user_id, event_type) do nothing`;
    }));
    const rows = await db<PolicyRow[]>`select * from proactive_policies where user_id = ${userId} order by event_type`;
    return rows.map(policyFromRow);
  }

  async updatePolicy(userId: string, eventType: ProactiveEventType, changes: Parameters<ProactiveStore['updatePolicy']>[2]): Promise<ProactivePolicy> {
    const current = (await this.policies(userId, changes.timezone ?? 'UTC')).find((row) => row.eventType === eventType)!;
    const next = { ...current, ...changes };
    const db = requireDb();
    const rows = await db<PolicyRow[]>`update proactive_policies set
      enabled=${next.enabled}, outcome=${next.outcome}, minimum_severity=${next.minimumSeverity}, quiet_start=${next.quietStart},
      quiet_end=${next.quietEnd}, timezone=${next.timezone}, cooldown_minutes=${next.cooldownMinutes}, daily_cap=${next.dailyCap},
      confirmed_at=now(), updated_at=now() where user_id=${userId} and event_type=${eventType} returning *`;
    if (!rows[0]) throw Errors.notFound('that proactive policy');
    return policyFromRow(rows[0]);
  }

  async upsertEvent(input: DetectedProactiveEvent, status: ProactiveEventStatus, decision: ProactiveEvent['policyDecision'], now: Date): Promise<StoredEventResult> {
    const db = requireDb();
    const existing = await db<EventRow[]>`select * from proactive_events where user_id=${input.userId} and dedupe_key=${input.dedupeKey} limit 1`;
    const versionChanged = Boolean(existing[0] && existing[0].source_version !== input.sourceVersion);
    const rows = await db<EventRow[]>`insert into proactive_events
      (user_id,event_type,dedupe_key,source_version,source_ref,severity,confidence,title,summary,recommendation,evidence,action_link,effective_at,expires_at,status,policy_decision,first_detected_at,last_seen_at)
      values (${input.userId},${input.type},${input.dedupeKey},${input.sourceVersion},${input.sourceRef},${input.severity},${input.confidence},${input.title},${input.summary},${input.recommendation},${input.evidence},${input.actionLink},${input.effectiveAt},${input.expiresAt},${status},${decision},${now},${now})
      on conflict (user_id,dedupe_key) do update set source_version=excluded.source_version,source_ref=excluded.source_ref,severity=excluded.severity,
        confidence=excluded.confidence,title=excluded.title,summary=excluded.summary,recommendation=excluded.recommendation,evidence=excluded.evidence,
        action_link=excluded.action_link,effective_at=excluded.effective_at,expires_at=excluded.expires_at,status=excluded.status,
        policy_decision=excluded.policy_decision,last_seen_at=excluded.last_seen_at,updated_at=now()
      returning *`;
    return { event: eventFromRow(rows[0]!), isNew: !existing[0], versionChanged, previousStatus: existing[0]?.status ?? null, previousDecision: existing[0]?.policy_decision ?? null };
  }

  async resolveMissing(userId: string, activeKeys: Set<string>, scannedTypes: ProactiveEventType[], now: Date): Promise<number> {
    const db = requireDb();
    const keys = [...activeKeys];
    const rows = keys.length
      ? await db<{ id: string }[]>`update proactive_events set status='resolved',updated_at=${now} where user_id=${userId} and event_type in ${db(scannedTypes)} and status in ('observed','active') and dedupe_key not in ${db(keys)} returning id`
      : await db<{ id: string }[]>`update proactive_events set status='resolved',updated_at=${now} where user_id=${userId} and event_type in ${db(scannedTypes)} and status in ('observed','active') returning id`;
    return rows.length;
  }

  async notificationCount(userId: string, day: string, eventType: ProactiveEventType): Promise<number> {
    const db = requireDb();
    const rows = await db<{ count: number }[]>`select count(*)::int as count from proactive_notifications n join proactive_events e on e.id=n.event_id where n.user_id=${userId} and n.local_day=${day} and e.event_type=${eventType}`;
    return rows[0]?.count ?? 0;
  }

  async notify(event: ProactiveEvent, outcome: ProactiveOutcome, day: string, cooldownMinutes: number, now: Date): Promise<boolean> {
    const db = requireDb();
    const existing = await db<{ id: string; status: NotificationStatus; source_version: string; snoozed_until: Date | null; last_notified_at: Date }[]>`select id,status,source_version,snoozed_until,last_notified_at from proactive_notifications where event_id=${event.id} and channel='in_app' limit 1`;
    const row = existing[0];
    if (row) {
      if (row.source_version === event.sourceVersion || row.status === 'snoozed' && row.snoozed_until && row.snoozed_until > now) return false;
      if (now.getTime() - row.last_notified_at.getTime() < cooldownMinutes * 60_000) return false;
      await db`update proactive_notifications set source_version=${event.sourceVersion},status='unread',outcome=${outcome},local_day=${day},acknowledged_at=null,snoozed_until=null,last_notified_at=${now},updated_at=${now} where id=${row.id} and user_id=${event.userId}`;
      return true;
    }
    await db`insert into proactive_notifications (event_id,user_id,source_version,channel,status,outcome,local_day,shown_at,last_notified_at) values (${event.id},${event.userId},${event.sourceVersion},'in_app','unread',${outcome},${day},${now},${now})`;
    return true;
  }

  async notifications(userId: string, limit = 20, now = new Date()): Promise<ProactiveNotification[]> {
    const db = requireDb();
    await db`update proactive_notifications set status='unread',snoozed_until=null,updated_at=${now} where user_id=${userId} and status='snoozed' and snoozed_until<=${now}`;
    const rows = await db<Array<EventRow & { notification_id: string; notification_status: NotificationStatus; outcome: ProactiveOutcome; local_day: string; shown_at: Date; acknowledged_at: Date | null; snoozed_until: Date | null; last_notified_at: Date }>>`
      select e.*,n.id as notification_id,n.status as notification_status,n.outcome,n.local_day,n.shown_at,n.acknowledged_at,n.snoozed_until,n.last_notified_at
      from proactive_notifications n join proactive_events e on e.id=n.event_id
      where n.user_id=${userId} and n.status in ('unread','read') and e.status='active' and e.expires_at>${now}
      order by case e.severity when 'critical' then 4 when 'high' then 3 when 'normal' then 2 else 1 end desc,n.last_notified_at desc limit ${limit}`;
    return rows.map((row) => ({ id: row.notification_id, eventId: row.id, userId: row.user_id, status: row.notification_status,
      outcome: row.outcome, localDay: row.local_day, shownAt: row.shown_at.toISOString(), acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
      snoozedUntil: row.snoozed_until?.toISOString() ?? null, lastNotifiedAt: row.last_notified_at.toISOString(), event: eventFromRow(row) }));
  }

  async setNotificationStatus(userId: string, id: string, status: Exclude<NotificationStatus, 'snoozed'>, now: Date): Promise<boolean> {
    const db = requireDb();
    const rows = await db<{ id: string }[]>`update proactive_notifications set status=${status},acknowledged_at=${now},snoozed_until=null,updated_at=${now} where id=${id} and user_id=${userId} returning id`;
    return rows.length === 1;
  }

  async snooze(userId: string, id: string, until: Date, now: Date): Promise<boolean> {
    const db = requireDb();
    const rows = await db<{ id: string }[]>`update proactive_notifications set status='snoozed',acknowledged_at=${now},snoozed_until=${until},updated_at=${now} where id=${id} and user_id=${userId} returning id`;
    return rows.length === 1;
  }

  async recordRun(userId: string, result: ProactiveScanResult): Promise<void> {
    const db = requireDb();
    await db`insert into proactive_runs (user_id,scanned_at,status,detected_count,notified_count,observed_count,suppressed_count,resolved_count,degraded_sources,delivery_mode)
      values (${userId},${result.scannedAt},${result.degradedSources.length ? 'degraded' : 'success'},${result.detected},${result.notified},${result.observed},${result.suppressed},${result.resolved},${result.degradedSources},${result.deliveryMode})`;
  }

  async diagnostics(userId: string): Promise<ProactiveDiagnostics> {
    const db = requireDb();
    const rows = await db<Array<{ scanned_at: Date; detected_count: number; notified_count: number; observed_count: number; suppressed_count: number; resolved_count: number; degraded_sources: string[]; delivery_mode: 'observe' | 'notify' }>>`select * from proactive_runs where user_id=${userId} order by scanned_at desc limit 1`;
    const row = rows[0];
    return { lastRun: row ? { scannedAt: row.scanned_at.toISOString(), detected: row.detected_count, notified: row.notified_count, observed: row.observed_count, suppressed: row.suppressed_count, resolved: row.resolved_count, degradedSources: row.degraded_sources, deliveryMode: row.delivery_mode } : null };
  }
}

let singleton: ProactiveStore | null = null;
export function proactiveStore(): ProactiveStore {
  singleton ??= hasDb() ? new PostgresProactiveStore() : new MemoryProactiveStore();
  return singleton;
}

export function setProactiveStoreForTests(store: ProactiveStore | null): void { singleton = store; }
