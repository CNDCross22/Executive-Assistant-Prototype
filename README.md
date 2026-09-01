# Hermes

A private AI executive assistant for Arete Care team members, connected to one Microsoft 365 tenant.

One conversation. Ask it about your email, your day, or who is waiting on you. It reads
your real Outlook, tells you what it actually found, and checks with you before it changes
anything.

---

## What is built

| | Status |
|---|---|
| Microsoft sign-in, locked to one tenant and an allowlist | working |
| Encrypted server-side token storage, nothing in the browser | working |
| Graph layer — profile, mailbox settings, mail read/search/thread | working |
| Deterministic triage — priority ranking and follow-up detection, no AI | working |
| Hermes agent — bounded loop, validated tools, prompt-injection boundary | working |
| Chat interface | working |
| Honest setup screen when something is not configured | working |
| Actions (drafts, sending, calendar, contacts and tasks) behind approval | working |
| Persistent, approval-controlled memory and observed proposals | working |
| Bounded long-conversation context and scoped, expiring memory | working |
| Evidence-backed email analysis, thread state, calendar conflicts and free/busy recommendations | working, live-tenant verification required |
| Purpose-based model policy and privacy-safe workflow telemetry | working, legacy defaults active |
| Controlled proactive in-app notices and recommendations | working, read-only |
| Attachment metadata and bounded safe-text inspection | working; PDF and Office extraction deferred |
| Teams channel reading | working, read-only; tenant consent required |
| OneDrive and SharePoint file discovery and safe-text reading | working, read-only; tenant consent required |
| Unattended read-only polling | implemented, off by default |
| Autonomous/background Microsoft 365 action | deliberately not implemented |

Anything not built is absent, not stubbed. The app will tell you what it cannot do rather
than pretend.

---

## Getting it running

Needs Node 22+ and an OpenAI API account with credits.

```bash
npm install
npm run gen:secrets      # writes SESSION_SECRET and ENCRYPTION_KEY into .env
```

Then fill in `.env`. The app starts without any of it and shows a setup screen listing
exactly what is missing, so the order does not matter.

### 1. Microsoft app registration

At [entra.microsoft.com](https://entra.microsoft.com) → **App registrations** → **New registration**

- Name: `Hermes EA`
- Account types: **Accounts in this organizational directory only**
- Redirect URI: **Web** → `http://localhost:4000/api/auth/callback`

Then **Certificates & secrets** → **New client secret** (copy the *Value*, not the Secret ID).

Then **API permissions** → **Microsoft Graph** → **Delegated permissions**, add the exact active set:

```
User.Read   User.ReadBasic.All   MailboxSettings.ReadWrite
Mail.ReadWrite   Mail.Send   Calendars.ReadWrite
Contacts.ReadWrite   People.Read   Tasks.ReadWrite
Team.ReadBasic.All   Channel.ReadBasic.All   ChannelMessage.Read.All
Files.Read   Sites.Read.All   offline_access
```

Do not add any **Application** permissions. Then select **Grant admin consent** for the tenant.
`ChannelMessage.Read.All` specifically requires administrator consent; tenant policy may require
approval for additional delegated permissions.

Copy the Client ID and Tenant ID from the Overview page into `.env`.

After a scope change, sign out and reconnect Hermes so the encrypted token cache contains a token
with the new grants. See `apps/api/src/config/graphScopes.ts` and `docs/MICROSOFT_GRAPH.md`.

### 2. Who may sign in

```dotenv
ALLOWED_EMAIL_DOMAINS=aretecare.com.au
```

Every account must pass both the Microsoft tenant lock and this exact email-domain allowlist.
Use `PRIMARY_USER_EMAIL` or `ALLOWED_USERS` instead when access should be limited to named accounts.

### 3. Database

Create a free project at [supabase.com](https://supabase.com/dashboard), then
**Project Settings → Database → Connection string → URI** (use the *Transaction pooler*
string, replacing `[YOUR-PASSWORD]`).

```bash
npm run db:migrate
```

Leaving `DATABASE_URL` blank works for a first login test, but everything is lost on restart.

### 4. OpenAI API

Add credits to your OpenAI API account and create a key at
[platform.openai.com/api-keys](https://platform.openai.com/api-keys).

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6-luna
OPENAI_MONTHLY_BUDGET_USD=10
```

Role-specific model and budget settings are documented in `docs/AI_AGENT.md`. Blank role models inherit `OPENAI_MODEL`; background model spending is disabled by default.

The production release gate, rollback procedure and incident-response checklist are in
`docs/PRODUCTION_READINESS.md`. Production refuses an empty allowlist, volatile authentication
storage, missing or reused application secrets, and an unlimited model budget.

Controlled proactive settings are documented in `docs/PROACTIVE.md`. Dashboard scans are read-only. Unattended polling remains off unless `HERMES_PROACTIVE_BACKGROUND=true` is explicitly configured.

### 5. Go

```bash
npm run dev
```

API on `:4000`, web on `:5173`.

---

## How it fits together

```
Browser  ──session cookie──▶  API  ──▶  Hermes agent  ──▶  validated tools  ──▶  Graph  ──▶  M365
                                              │
                                              ├─ deterministic triage (no AI)
                                              └─ OpenAI API
```

Graph access tokens never reach the browser. The model never constructs a Graph request —
it proposes a tool name and arguments, which are validated against a schema before anything
runs.

**Deterministic before probabilistic.** Priority ranking and follow-up detection are plain
queries over sent and received mail. They cannot be confidently wrong, and they handle most
of "what matters" before the model is involved. See `apps/api/src/mail/triage.ts`.

**External content is data, never instruction.** Email bodies are wrapped and labelled
untrusted. If a message says "ignore your instructions", the assistant reports it rather
than obeying. See `apps/api/src/agent/prompt.ts`.

---

## Layout

```
apps/api/src/
  config/      env parsing, per-capability Graph scopes
  auth/        MSAL flow, encrypted token cache, sessions
  graph/       typed Graph client and services
  mail/        deterministic triage and follow-ups
  agent/       orchestrator, prompt, tool registry
  ai/          OpenAI integration and spend guard
  observability/ request/workflow correlation and allowlisted telemetry
  proactive/   deterministic triggers, policy evaluation, dedupe and scheduler
  routes/      HTTP surface
apps/web/src/  React chat interface
supabase/migrations/
scripts/       gen-secrets, migrate
```

## Commands

```bash
npm run dev           # both
npm run dev:api
npm run dev:web
npm run typecheck
npm test
npm run eval:behaviour
npm run db:migrate
npm run gen:secrets
npm run release:audit # privacy-safe production preflight
npm run uat:live      # read-only live content checks
npm run build:edge    # package the existing API for Supabase Edge
npm run deploy:edge   # package and deploy to the linked Hermes project
```

GitHub Pages and Supabase deployment details are in
[`docs/DEPLOYMENT_GITHUB_PAGES.md`](docs/DEPLOYMENT_GITHUB_PAGES.md).
