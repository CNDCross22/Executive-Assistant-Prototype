export const PROACTIVE_EVENT_TYPES = [
  'security_warning',
  'email_attention',
  'overdue_reply',
  'overdue_follow_up',
  'calendar_conflict',
  'upcoming_meeting',
] as const;

export type ProactiveEventType = (typeof PROACTIVE_EVENT_TYPES)[number];
export type ProactiveSeverity = 'low' | 'normal' | 'high' | 'critical';
export type ProactiveOutcome = 'notify' | 'recommend';
export type ProactiveEventStatus = 'observed' | 'active' | 'resolved' | 'expired';
export type NotificationStatus = 'unread' | 'read' | 'dismissed' | 'snoozed';

export interface ProactivePolicy {
  id: string;
  userId: string;
  eventType: ProactiveEventType;
  enabled: boolean;
  outcome: ProactiveOutcome;
  minimumSeverity: ProactiveSeverity;
  quietStart: string | null;
  quietEnd: string | null;
  timezone: string;
  cooldownMinutes: number;
  dailyCap: number;
  confirmedAt: string;
  updatedAt: string;
}

export interface DetectedProactiveEvent {
  userId: string;
  type: ProactiveEventType;
  dedupeKey: string;
  sourceVersion: string;
  sourceRef: string;
  severity: ProactiveSeverity;
  confidence: number;
  title: string;
  summary: string;
  recommendation: string | null;
  evidence: string[];
  actionLink: string | null;
  effectiveAt: string | null;
  expiresAt: string;
}

export interface ProactiveEvent extends DetectedProactiveEvent {
  id: string;
  status: ProactiveEventStatus;
  policyDecision: 'observe' | 'notify' | 'recommend' | 'disabled' | 'below_threshold' | 'quiet_hours' | 'daily_cap';
  firstDetectedAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export interface ProactiveNotification {
  id: string;
  eventId: string;
  userId: string;
  status: NotificationStatus;
  outcome: ProactiveOutcome;
  localDay: string;
  shownAt: string;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  lastNotifiedAt: string;
  event: ProactiveEvent;
}

export interface ProactiveScanResult {
  scannedAt: string;
  detected: number;
  notified: number;
  observed: number;
  suppressed: number;
  resolved: number;
  degradedSources: string[];
  deliveryMode: 'observe' | 'notify';
}
