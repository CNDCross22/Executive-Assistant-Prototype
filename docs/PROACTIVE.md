# Controlled proactive operation

Hermes can now notice selected mailbox and calendar conditions without receiving authority to act on them.

## Safety boundary

The proactive engine only performs Microsoft 365 reads. It may write event, policy, notification, run, and telemetry records to Hermes' database. It cannot send mail, create drafts, change calendar events, edit tasks, or bypass the existing preview and approval engine.

Microsoft content remains untrusted. Detectors consume the already-sanitised dashboard shapes, use deterministic rules, clamp displayed text, and never interpret retrieved text as policy or instruction.

## Triggers

- suspicious message warning;
- high-value email requiring attention;
- thread where the Director owes a reply;
- thread where another person has not replied;
- overlapping calendar events;
- non-all-day meeting within 24 hours.

Detectors do not invent deadlines. Only explicit parsed dates affect deadline urgency.

## Delivery controls

Each user and trigger has a structured policy: enabled state, notify or recommend outcome, severity threshold, quiet hours, timezone, cooldown, and local-day cap. Duplicate scans update one stable event. Source changes use a separate version fingerprint and can re-notify only after cooldown. Resolved or expired sources stop appearing. Dashboard scans use a per-user non-overlapping queue and do not delay the dashboard response; fresh results appear on the next poll.

The dashboard supports mark read, four-hour snooze, dismiss, source opening, and per-trigger enable/disable.

## Runtime configuration

```text
HERMES_PROACTIVE_DELIVERY=notify
HERMES_PROACTIVE_BACKGROUND=false
HERMES_PROACTIVE_INTERVAL_MINUTES=15
```

`observe` records events without delivering notices. Background polling is disabled by default. When enabled, it considers at most ten connected accounts, prevents overlapping runs in one process, uses the existing encrypted delegated token cache, and stops on server shutdown. The product remains intended for one Director.

## Storage and privacy

Apply migrations through `0012_proactive_user_binding.sql`. `0011` creates `proactive_policies`, `proactive_events`, `proactive_notifications`, and `proactive_runs`; `0012` enforces event/notification ownership with a composite foreign key. Logs contain counts, duration, and reason codes, not message bodies or tokens. Event records contain minimal user-visible summaries and server-side source references required for evidence and deduplication.

## Rollback

Set `HERMES_PROACTIVE_DELIVERY=observe` to suppress delivery, or disable individual policies. Set `HERMES_PROACTIVE_BACKGROUND=false` to stop unattended reads. Removing the UI or routes does not affect Microsoft 365 state. Retain the tables as audit history; no external action needs reversal.
