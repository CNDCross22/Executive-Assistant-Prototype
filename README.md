# Hermes

A private AI executive assistant for one Director, connected to one Microsoft 365 tenant.

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
| Actions (drafts, sending, calendar writes) behind approval | not yet |
| Persistent memory and learned preferences | not yet |

Anything not built is absent, not stubbed. The app will tell you what it cannot do rather
than pretend.

---

## Getting it running

Needs Node 22+. Nothing else installs locally except the AI model.

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

Then **API permissions** → **Microsoft Graph** → **Delegated**, add:

```
User.Read   MailboxSettings.Read   Mail.Read
Calendars.Read   Contacts.Read   People.Read   offline_access
```

Then **Grant admin consent**.

Copy the Client ID and Tenant ID from the Overview page into `.env`.

> Read-only to begin with. `Mail.Send` and `Calendars.ReadWrite` are added at the stage that
> needs them, not before — see `apps/api/src/config/graphScopes.ts`.

### 2. Who may sign in

```dotenv
PRIMARY_USER_EMAIL=test.account@yourdomain.com
```

Use a test mailbox first. Anyone not listed is refused, even inside your own tenant.

### 3. Database

Create a free project at [supabase.com](https://supabase.com/dashboard), then
**Project Settings → Database → Connection string → URI** (use the *Transaction pooler*
string, replacing `[YOUR-PASSWORD]`).

```bash
npm run db:migrate
```

Leaving `DATABASE_URL` blank works for a first login test, but everything is lost on restart.

### 4. The AI model

```powershell
winget install Ollama.Ollama
ollama pull hermes3:8b
```

Runs in the background on port 11434. Nothing else to configure.

To move to a hosted model later, change three lines in `.env` — no code changes:

```dotenv
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=nousresearch/hermes-4-70b
AI_API_KEY=sk-or-...
```

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
                                              └─ AI provider (local or hosted)
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
  ai/          provider abstraction
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
npm run db:migrate
npm run gen:secrets
```
