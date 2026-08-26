import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, '../../../../.env'), quiet: true });

/**
 * A key present but blank in .env arrives as '' rather than undefined, which
 * would otherwise fail `.min(1)` and stop the server from starting at all.
 * Blank means "not configured yet", so it is normalised away here.
 */
const blankToUndefined = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const optionalText = () => blankToUndefined(z.string().min(1).optional());
const optionalUrl = () => blankToUndefined(z.string().url().optional());
const optionalEmail = () => blankToUndefined(z.string().email().optional());
const optionalSecret = () => blankToUndefined(z.string().min(32).optional());

/**
 * Environment is parsed leniently on purpose.
 *
 * The app must START even when Microsoft, the database or the AI provider are
 * not configured yet, so it can show an honest setup screen instead of
 * pretending an integration exists. See `getSetupStatus()`.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:4000'),

  // Microsoft Entra ID
  MICROSOFT_CLIENT_ID: optionalText(),
  MICROSOFT_CLIENT_SECRET: optionalText(),
  MICROSOFT_TENANT_ID: optionalText(),
  MICROSOFT_REDIRECT_URI: optionalUrl(),

  // Who is allowed in. Comma-separated addresses.
  ALLOWED_USERS: z.string().default(''),
  PRIMARY_USER_EMAIL: optionalEmail(),

  // Supabase / Postgres
  DATABASE_URL: optionalText(),

  // AI provider
  AI_PROVIDER: z.enum(['openai-compatible', 'anthropic']).default('openai-compatible'),
  AI_BASE_URL: z.string().url().default('http://localhost:11434/v1'),
  AI_MODEL: z.string().default('gpt-5-mini'),
  AI_API_KEY: z.string().default('ollama'),
  /** Hard monthly cap in USD. 0 disables the cap. */
  AI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(5),

  // Secrets
  SESSION_SECRET: optionalSecret(),
  ENCRYPTION_KEY: optionalSecret(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Development only. Serves a fixture mailbox so the assistant can be tried
  // before Microsoft is connected. Refused in production; the UI shows a banner.
  DEMO_MODE: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
});

export type Env = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Only malformed values land here (bad URL, bad port). Missing optionals do not.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env: Env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

if (env.DEMO_MODE && isProd) {
  console.error('DEMO_MODE cannot be enabled in production. Refusing to start.');
  process.exit(1);
}

export const isDemo = env.DEMO_MODE;

export interface SetupCheck {
  key: string;
  label: string;
  ready: boolean;
  detail: string;
  action?: string;
}

export interface SetupStatus {
  ready: boolean;
  checks: SetupCheck[];
}

/**
 * Honest report of what is and is not wired up. The frontend renders this
 * instead of guessing, so we never show a working UI over a dead integration.
 */
export function getSetupStatus(): SetupStatus {
  if (env.DEMO_MODE) {
    return {
      ready: true,
      checks: [
        {
          key: 'demo',
          label: 'Demo mode',
          ready: true,
          detail: 'Serving a fixture mailbox. No Microsoft account is connected and no real email is involved.',
        },
      ],
    };
  }

  const microsoftReady = Boolean(
    env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_TENANT_ID,
  );
  const secretsReady = Boolean(env.SESSION_SECRET && env.ENCRYPTION_KEY);

  const checks: SetupCheck[] = [
    {
      key: 'microsoft',
      label: 'Microsoft sign-in',
      ready: microsoftReady,
      detail: microsoftReady
        ? `Locked to tenant ${env.MICROSOFT_TENANT_ID}`
        : 'Register an app in Microsoft Entra ID, then set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT_ID.',
      action: 'https://entra.microsoft.com',
    },
    {
      key: 'database',
      label: 'Database',
      ready: Boolean(env.DATABASE_URL),
      detail: env.DATABASE_URL
        ? 'Connection string present'
        : 'Create a free Supabase project and set DATABASE_URL to its connection string.',
      action: 'https://supabase.com/dashboard',
    },
    {
      key: 'secrets',
      label: 'Application secrets',
      ready: secretsReady,
      detail: secretsReady
        ? 'Session and encryption keys set'
        : 'Set SESSION_SECRET and ENCRYPTION_KEY. Run: npm run gen:secrets',
    },
    {
      key: 'allowlist',
      label: 'Who may sign in',
      ready: Boolean(env.PRIMARY_USER_EMAIL || env.ALLOWED_USERS.trim()),
      detail: env.PRIMARY_USER_EMAIL
        ? `Primary mailbox ${env.PRIMARY_USER_EMAIL}`
        : 'Set PRIMARY_USER_EMAIL to the mailbox this assistant serves.',
    },
  ];

  return { ready: checks.every((c) => c.ready), checks };
}

/** Addresses permitted to sign in, lower-cased. */
export function allowedUsers(): string[] {
  const list = env.ALLOWED_USERS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (env.PRIMARY_USER_EMAIL) list.push(env.PRIMARY_USER_EMAIL.toLowerCase());
  return [...new Set(list)];
}

export function redirectUri(): string {
  return env.MICROSOFT_REDIRECT_URI ?? `${env.API_URL}/api/auth/callback`;
}
