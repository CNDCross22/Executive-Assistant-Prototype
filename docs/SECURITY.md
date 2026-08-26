# Security

This application holds standing access to a Director's mailbox. That is the
threat model: not a leaked marketing database, but someone reading, and
eventually writing, as her.

---

## What an attacker would want

| Goal | Defence |
|---|---|
| Read her mail | Tenant lock + allowlist + server-side tokens |
| Make Hermes act on their behalf | Prompt-injection boundary + capability guard |
| Make her *believe* Hermes acted | Claim guard |
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

Seven delegated scopes, all read-only, each attached to a specific capability in
`config/graphScopes.ts`:

```
User.Read  MailboxSettings.Read  Mail.Read
Calendars.Read  Contacts.Read  People.Read  offline_access
```

**No Application permissions.** Delegated means Hermes can only reach what that
one account can reach. `Mail.Read` as an *Application* permission would mean
every mailbox in the organisation — a different security posture entirely, and
the code would not work with it anyway, since every call uses `/me`.

Write scopes (`Mail.Send`, `Calendars.ReadWrite`) exist in the capability map
but are `enabled: false`, so they are never requested at consent.

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
3. **The capability guard** (`agent/guards.ts`). An action we cannot perform is
   refused before the model is even consulted, so it cannot agree to it.
4. **The claim guard**. Any reply asserting an action is checked against what
   actually executed. Unbacked claims are blocked and logged as errors.

**Memory is never written from email contents.** If a hostile message could
create a durable belief, an attacker would only need to be believed once.

---

## Untrusted content in the browser

Email bodies are converted to **plain text** server-side (`htmlToText`) and
rendered as text. There is no `dangerouslySetInnerHTML` anywhere in the
frontend. Not having markup beats sanitising it.

Message ids are replaced with short opaque handles (`e1`, `e2`) before the model
sees them, and the reply is scrubbed of anything resembling an id or an internal
name before it reaches her.

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

`AI_MONTHLY_BUDGET_USD` is a hard stop, not a warning: past it, model calls are
refused. Exhausting it degrades the assistant rather than breaking it, since the
deterministic answers keep working. A model with no published rate is billed at
the highest known rate, so an unpriced model cannot quietly overspend.

---

## Logging

Structured JSON via pino, with cookies, authorization headers, access tokens,
refresh tokens and client secrets redacted at the logger level.

Every model call is recorded with token counts and cost. Every blocked claim is
logged as an error. **Message contents are not logged.**

---

## What is deliberately not built yet

- **The approval engine.** Every tool above risk level 0 is refused at the
  registry. Write access must not exist before there is a confirmation step in
  front of it.
- **`memory_forget` is rated risk 3** — destructive and invisible — so it will
  go through approval when that lands.
- **Demo mode** bypasses authentication and is refused outright when
  `NODE_ENV=production`. It shows a permanent banner.

---

## Before this holds real mail

- [ ] Rotate `SESSION_SECRET` and `ENCRYPTION_KEY` for production
- [ ] Rotate any credential that has ever appeared in a chat, screenshot or commit
- [ ] `DEMO_MODE=false`
- [ ] HTTPS with `NODE_ENV=production` so `Secure` cookies apply
- [ ] `PRIMARY_USER_EMAIL` set to exactly the intended mailbox
- [ ] Confirm no write scopes were consented beyond the seven above
- [ ] `npm test` green

---

## Reporting

This is a private single-tenant tool. If something looks wrong, the fastest
containment is to revoke the app's consent in Entra ID — that immediately
invalidates every refresh token, and Hermes stops being able to read anything.
