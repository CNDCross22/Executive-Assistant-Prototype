# Production readiness

This is the Phase 7 release gate for Hermes. It assumes one Director, one Microsoft 365 tenant,
delegated Graph access, PostgreSQL persistence and the existing approval architecture.

## Automated release gate

Run from the repository root:

```text
npm run typecheck
npm test
npm run eval:behaviour
npm run build
git diff --check
npm run test:graph
npm run release:audit
npm run uat:live
```

The first five are required for every release. `release:audit` checks production configuration
without printing secrets. `test:graph` is read-only and must run against the
intended test tenant after any Graph scope or service change. It logs counts and status only, never
mail, channel or file contents.

`uat:live` performs bounded, privacy-safe content checks where harmless tenant fixtures exist. See
`docs/UAT.md` for the current evidence and remaining Director-visible checks.

## Configuration gate

Production startup now refuses:

- missing `SESSION_SECRET` or `ENCRYPTION_KEY`;
- reuse of the same value for both secrets;
- missing `DATABASE_URL`, which would otherwise enable volatile authentication storage;
- an empty Director allowlist;
- a disabled global model budget;
- `DEMO_MODE=true`.

Generate independent secrets with `npm run gen:secrets`. Keep `.env` outside source control. Use a
Supabase transaction-pooler connection string and retain database backups. A missing or malformed
integration may still be reported through the setup screen, but security-critical production
defaults cannot silently degrade.

The allowlist fails closed. If neither `PRIMARY_USER_EMAIL` nor `ALLOWED_USERS` contains the
signed-in address, authentication is rejected even when the account belongs to the correct tenant.

## Microsoft 365 gate

- Use Delegated permissions only. Do not add Application permissions.
- Grant only the exact scopes in `config/graphScopes.ts`.
- Run `npm run test:graph` after consent and reconnection.
- Confirm the account is the intended Director test account before any mutation test.
- Use a dedicated test message, meeting, contact and task for approved end-to-end mutation tests.
- Verify the preview before each test and inspect Microsoft 365 after execution.

Hermes retries idempotent reads after throttling or transient service errors. Mutating POST, PATCH
and DELETE requests are attempted once only. A server or network failure after submission is treated
as an unknown outcome, and the Director must check Microsoft 365 before trying again.

## Security gate

- Tenant ID and Director address are not exposed through public setup details.
- Access and refresh tokens remain encrypted and server-side.
- Session and flow cookies are signed, HTTP-only and Secure in production.
- Request logs exclude query strings, cookies and authorisation headers.
- Telemetry excludes tool arguments and Microsoft 365 content.
- Email, attachment, Teams and file content remains untrusted plain text.
- File retrieval is limited to 5 MB before and during download.
- Graph bearer tokens are stripped before following file-download redirects.
- Every mutating tool still has a persisted preview and explicit confirmation.

## Operational checks

Monitor:

- Graph 429 rate and `Retry-After` duration;
- Graph 5xx and unknown mutation outcomes;
- OpenAI timeouts, token use and cost by budget category;
- approval creation, supersession, expiry, execution and failure;
- blocked false-action claims and suspicious-content detections;
- database connection exhaustion and request latency;
- proactive scan overlap and duration.

Use workflow, request and conversation identifiers to correlate events. Do not add message bodies,
file contents, search queries, tool arguments or credentials to logs while investigating.

## Incident response

### Suspected Microsoft token exposure

1. Disable the Entra application or revoke the user's sessions.
2. Rotate the Microsoft client secret.
3. Mark the Hermes connection for reauthentication and delete active Hermes sessions.
4. Review privacy-safe audit records for unexpected tools and approvals.
5. Reconnect only after the cause is understood.

### Session or encryption secret exposure

1. Stop Hermes.
2. Rotate both secrets independently.
3. Revoke all application sessions. Rotating the encryption key intentionally invalidates the stored
   Microsoft token cache and requires reconnection.
4. Restart and run the authenticated smoke checks.

### Unknown Microsoft mutation outcome

Do not retry automatically. Check the relevant Outlook, Calendar, Contacts or To Do target. If the
change is absent, prepare a new preview and request a new approval. If present, record it as completed
without executing again.

### Prompt-injection incident

Do not follow or preserve the hostile instruction. Record the detection category without copying the
content into telemetry. Confirm that no mutation receipt exists. Remove or report the source through
the Director's normal security process.

### Model budget exhaustion

Keep Graph mutations disabled unless the deterministic approval workflow can complete safely. Review
usage by model role and budget category before raising a cap. Background model spending remains zero
unless explicitly configured.

## Backup and rollback

Before deployment, back up PostgreSQL and record the deployed commit and environment schema. Phase 7
adds no database migration.

For application rollback, deploy the previous build without deleting approval, memory, audit or
proactive records. Schema changes through migration `0012` remain backward compatible with the
previous application phases. Never roll back by deleting audit history.

Disable unattended activity immediately with:

```text
HERMES_PROACTIVE_BACKGROUND=false
HERMES_PROACTIVE_DELIVERY=observe
```

If an integration is unsafe or unstable, disable its capability in `graphScopes.ts`, reconnect to
remove unnecessary consent where appropriate, and retain the audit trail.

## Known live-verification gaps

The current test tenant has no joined Team and no sampled message with an attachment. Permission
claims and empty-result API calls pass, but actual Teams channel-message and attachment-content reads
still require suitable existing test data. Do not create or send external data merely to satisfy a
test. When fixtures become available, use a harmless text attachment and a dedicated test Team.

PDF and Office document extraction, malware scanning, Teams writes and file mutations are not part of
the current product and must not be represented as production capabilities.
