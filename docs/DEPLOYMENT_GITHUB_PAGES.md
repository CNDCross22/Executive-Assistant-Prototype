# GitHub Pages and Supabase deployment

Hermes uses two deployment surfaces:

- GitHub Pages serves the compiled React interface.
- Supabase Edge Functions serves the existing Fastify API through an injection adapter.
- Supabase Postgres remains the persistent database.
- Every runtime credential is stored in the Supabase Edge environment, never in Pages or the repository.

## Production endpoints

- Web: `https://cndcross22.github.io/Executive-Assistant-Prototype/`
- API: `https://wkqhlcilewyskpfvndsd.supabase.co/functions/v1/api`
- Microsoft callback: `https://wkqhlcilewyskpfvndsd.supabase.co/functions/v1/api/api/auth/callback`

The Microsoft callback must be registered as a Web redirect URI on the existing single-tenant Entra
application before production sign-in can complete. The existing delegated Graph permissions remain
unchanged; no Application permission is introduced by this deployment.

## Supabase runtime environment

Required application values are held by Supabase:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TENANT_ID`
- `ALLOWED_EMAIL_DOMAINS` (or `PRIMARY_USER_EMAIL`/`ALLOWED_USERS` for named accounts)
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_MONTHLY_BUDGET_USD`
- `SESSION_SECRET`
- `ENCRYPTION_KEY`
- `HERMES_APP_URL`
- `HERMES_EDGE_RUNTIME=true`

Supabase supplies `SUPABASE_URL` and `SUPABASE_DB_URL`. The Edge wrapper maps these values in memory;
it does not mutate the runtime environment or place credentials in the client bundle.

Inspect secret names and hashes, never values:

```powershell
supabase secrets list --project-ref wkqhlcilewyskpfvndsd
```

## Deployment

Build and deploy the API:

```powershell
npm run build:edge
supabase functions deploy api --project-ref wkqhlcilewyskpfvndsd --no-verify-jwt
```

The Edge gateway JWT check is intentionally disabled because Hermes uses its own signed, database-backed
HttpOnly session and must expose public Microsoft login/callback routes. Exact-origin checks, the Director
allowlist, tenant validation, rate limits and approval engine remain active.

Pushing `main` runs `.github/workflows/pages.yml`. The workflow uses only GitHub's short-lived deployment
token. It does not require an OpenAI, Microsoft, database or Supabase secret.

## Browser cookie limitation

The initial `github.io` and `supabase.co` addresses are cross-site. Hermes uses `Secure`, `HttpOnly`,
`SameSite=None` cookies and validates the exact Pages origin for mutations. Browsers that block all
third-party cookies may still refuse the session cookie.

For a dependable production login, use a custom web domain and a Supabase custom API domain beneath the
same registrable domain. Do not replace the HttpOnly session with a token in local storage merely to work
around browser policy.

## Edge runtime constraints

- The API is request-driven. `HERMES_PROACTIVE_BACKGROUND` remains disabled.
- In-app proactive scans remain available and delivery begins in `observe` mode.
- The adapter preserves all existing route, approval, tenant, allowlist and output-sanitisation logic.
- The build embeds the reviewed `soul.md`; it does not embed `.env` or any credential.

## Rollback

Redeploy a previously committed source revision after running `npm run build:edge`. Database migrations are
not rolled back automatically. Do not delete approval, audit, memory or token-cache records during an
application rollback.
