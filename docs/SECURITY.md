# Security

This application holds standing access to a Director's mailbox. That is the
threat model: not a leaked marketing database, but someone reading, and
eventually writing, as her.

---

## What an attacker would want

| Goal | Defence |
|---|---|
| Read her mail | Tenant lock + allowlist + server-side tokens |
| Make the assistant act on their behalf | Prompt-injection boundary + capability guard |
| Make her *believe* the assistant acted | Claim guard |
| Steal the Microsoft tokens | Encrypted at rest, never sent to the browser |
| Learn about the system | Error mapping — no schema or stack ever returned |
| Exhaust the AI budget | Hard monthly cap |

---

## Identity

**Server-side OAuth only.** MSAL confidential client, authorization code flow with
PKCE. We never see her password, and no Graph token ever reaches the browser.

**Two independent gates at sign-in**, both in `routes/auth.routes.ts`:

1. **Tenant lock** — the `tid` claim must equal `MICROSOFT_TENANT_ID`. A valid
   Microsoft account from any other organisation is rejected.
2. **Allowlist** — the signed-in address must appear in `PRIMARY_USER_EMAIL` or
   `ALLOWED_USERS`. A colleague inside your own tenant cannot sign in.

The authority URL is single-tenant, so the common endpoint is never used.

**Sessions** are opaque 256-bit tokens. Only a SHA-256 hash is stored, so a
database leak yields nothing usable. Cookies are `httpOnly`, `signed`,
`SameSite=Lax`, and `Secure` in production. Fourteen-day expiry, revocable.

**Tokens at rest.** The MSAL cache — which contains the refresh token — is
encrypted with AES-256-GCM before it touches Postgres. Losing `ENCRYPTION_KEY`
invalidates every stored connection, which is the correct failure direction.

---

## Least privilege

Fourteen active Microsoft Graph delegated permissions, plus the OIDC and refresh scopes, each attached to a specific capability in
`config/graphScopes.ts`:

```
User.Read  User.ReadBasic.All  offline_access
Mail.ReadWrite  Mail.Send  Calendars.ReadWrite
Contacts.ReadWrite  People.Read  MailboxSettings.ReadWrite
Tasks.ReadWrite  Files.Read  Sites.Read.All
Team.ReadBasic.All  Channel.ReadBasic.All  ChannelMessage.Read.All
```

**No Application permissions.** Delegated means the assistant can only reach what that
one account can reach. `Mail.Read` as an *Application* permission would mean
every mailbox in the organisation — a different security posture entirely, and
the code would not work with it anyway, since every call uses `/me`.

All write operations remain gated by a persisted preview and explicit Director
approval even though the delegated write scopes have been granted.

**Mutations are never retried by the Graph transport.** Automatic retry is limited to GET requests
and explicitly declared read-only POST operations such as calendar free/busy. A transient or unknown
result from send, create, update or delete returns to the approval boundary for manual verification.

**The allowlist fails closed.** An empty allowlist authorises nobody; it does not expand access to
the configured tenant. Production also refuses volatile authentication storage, missing or reused
secrets, and a disabled model budget. See `docs/PRODUCTION_READINESS.md`.

---

## Prompt injection

Email is attacker-controlled text that we feed to a model with tool access.
Treating it as anything other than hostile would be negligent.

**Four layers, in order of reliability:**

1. **Deterministic detection** (`mail/suspicion.ts`). Injection attempts,
   exfiltration requests, credential phishing and lookalike domains are matched
   in code and the warning is attached to the data itself. This came after a
   model read an attack and summarised it politely as a normal request.
2. **The trust hierarchy** in the system prompt: instructions, then her, then
   tool results, then email content — which is explicitly labelled DATA.
3. **The approval engine** (`agent/approvals.ts`). Every change is stored with
   validated arguments and an opaque-id snapshot. Existing targets are fetched
   before approval so the card describes the real message, event, contact or
   task. The card is persisted with chat history, expires after 15 minutes and
   executes at most once after a standalone, unambiguous approval. Only one
   proposal may be pending per conversation; any intervening message
   supersedes it. Model-written confirmation prose cannot create an approval.
4. **The claim guard**. Any reply asserting an action is checked against what
   actually executed. Unbacked claims are blocked and logged as errors.

**Memory is never written from email contents.** If a hostile message could
create a durable belief, an attacker would only need to be believed once.

**Attachments, Teams posts, OneDrive files and SharePoint documents use the same trust boundary.**
They are flattened to bounded plain text, tagged as untrusted, checked by the deterministic
suspicion detector and never treated as system instructions. Text extraction uses an allowlist and
a 5 MB hard limit before and during download. Hermes does not execute or malware-scan files and
does not inspect unsupported PDF or Office formats in this phase.

**Proactive events do not create authority.** The event engine uses deterministic
read-only signals and stores internal notice state only. Retrieved text cannot
create a policy. The browser receives user-facing evidence, not Graph source ids,
dedupe keys, or source-version fingerprints. Background polling is off by default,
and no proactive path can call a mutating tool.

---

## Untrusted content in the browser

Email bodies are converted to **plain text** server-side (`htmlToText`) and
rendered as text. There is no `dangerouslySetInnerHTML` anywhere in the
frontend. Not having markup beats sanitising it.

Message ids are replaced with short opaque handles (`e1`, `e2`) before the model
sees them, and the reply is scrubbed of anything resembling an id or an internal
name before it reaches her.

Attachment, team, channel, site, drive and item ids are packed into the same opaque reference table.
Raw Microsoft identifiers and file download URLs are not returned to the model.

---

## The API surface

- **Zod on every input.** Bodies, params and query strings. Unvalidated input
  never reaches a service.
- **Parameterised SQL exclusively** via postgres.js tagged templates. No string
  concatenation anywhere.
- **UUID validation before querying**, so a malformed id is a clean 404 rather
  than a database error.
- **Error mapping** (`lib/errors.ts`). Postgres codes, Zod failures and unknown
  throws are all translated. Raw messages, error codes, stack traces and table
  names never leave the server.
- **CORS** restricted to `APP_URL` with credentials.
- **Helmet** for security headers.
- **Rate limiting** at 120 requests/minute in production.
- **Body limit** of 1 MB.

> **One ordering trap worth knowing:** Fastify encapsulates registered plugins,
> so `setErrorHandler` must be called *before* `app.register(...)`. Setting it
> afterwards silently leaves every route on the default handler — which is how
> raw Postgres errors reached the browser during development.

---

## Spend

`OPENAI_MONTHLY_BUDGET_USD` is a hard stop, not a warning: past it, model calls are
refused. Exhausting it degrades the assistant rather than breaking it, since the
deterministic answers keep working. A model with no published rate is billed at
the highest known rate, so an unpriced model cannot quietly overspend.

---

## Logging

Structured JSON via pino, with cookies, authorization headers, access tokens,
refresh tokens and client secrets redacted at the logger level.

Every model call is recorded with token counts, cost and privacy-safe workflow
metadata. Tool and approval events use a runtime field allowlist. Every blocked
claim is logged as a security event. **Message contents, tool arguments,
previews and credentials are not telemetry fields.**

---

## Deliberate safeguards

- **All mutations require approval**, including `memory_forget`, mailbox
  settings, meeting responses and attendee changes.
- **Durable memory is opt-in.** Explicit preferences create a deterministic
  approval card, and observed patterns remain inactive proposals until the
  Director approves them. One-off messages and inferred opinions are not
  silently promoted into active memory.
- **Execution and audit reporting are separated.** A confirmed Graph success is
  not misreported as a failure if the later audit write fails. An ambiguous
  Graph transport failure is reported as an unconfirmed outcome, prompting the
  Director to check Outlook before retrying.
- **Demo mode** bypasses authentication and is refused outright when
  `NODE_ENV=production`. It shows a permanent banner.

---

## Before this holds real mail

- [ ] Rotate `SESSION_SECRET` and `ENCRYPTION_KEY` for production
- [ ] Rotate any credential that has ever appeared in a chat, screenshot or commit
- [ ] `DEMO_MODE=false`
- [ ] HTTPS with `NODE_ENV=production` so `Secure` cookies apply
- [ ] `PRIMARY_USER_EMAIL` set to exactly the intended mailbox
- [ ] Confirm the consented delegated scopes match the fifteen listed above
- [ ] `npm test` green

---

## Reporting

This is a private single-tenant tool. If something looks wrong, the fastest
containment is to revoke the app's consent in Entra ID — that immediately
invalidates every refresh token, and the assistant stops being able to access Microsoft 365.
