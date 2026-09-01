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
const optionalBudget = () => blankToUndefined(z.coerce.number().min(0).optional());
const optionalReasoningEffort = () => blankToUndefined(
  z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
);
const optionalServiceTier = () => blankToUndefined(z.enum(['default', 'fast']).optional());

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
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // Microsoft Entra ID
  MICROSOFT_CLIENT_ID: optionalText(),
  MICROSOFT_CLIENT_SECRET: optionalText(),
  MICROSOFT_TENANT_ID: optionalText(),
  MICROSOFT_REDIRECT_URI: optionalUrl(),

  // Who is allowed in. Comma-separated addresses and/or organisation domains.
  // The Microsoft tenant lock still applies before either allowlist is checked.
  ALLOWED_USERS: z.string().default(''),
  ALLOWED_EMAIL_DOMAINS: z.string().default(''),
  PRIMARY_USER_EMAIL: optionalEmail(),

  // Supabase / Postgres
  DATABASE_URL: optionalText(),

  // OpenAI
  OPENAI_API_KEY: optionalText(),
  OPENAI_MODEL: z.string().default('gpt-5.6-luna'),
  OPENAI_FAST_MODEL: optionalText().default('gpt-5.6-luna'),
  OPENAI_EXECUTIVE_MODEL: optionalText().default('gpt-5.6-sol'),
  OPENAI_BRIEFING_MODEL: optionalText().default('gpt-5.6-sol'),
  OPENAI_BACKGROUND_MODEL: optionalText().default('gpt-5.6-luna'),
  OPENAI_REASONING_EFFORT: optionalReasoningEffort().default('none'),
  OPENAI_FAST_REASONING_EFFORT: optionalReasoningEffort().default('none'),
  OPENAI_EXECUTIVE_REASONING_EFFORT: optionalReasoningEffort().default('medium'),
  OPENAI_BRIEFING_REASONING_EFFORT: optionalReasoningEffort().default('medium'),
  OPENAI_BACKGROUND_REASONING_EFFORT: optionalReasoningEffort().default('none'),
  OPENAI_SERVICE_TIER: optionalServiceTier().default('default'),
  OPENAI_FAST_SERVICE_TIER: optionalServiceTier().default('fast'),
  OPENAI_EXECUTIVE_SERVICE_TIER: optionalServiceTier().default('fast'),
  OPENAI_BRIEFING_SERVICE_TIER: optionalServiceTier().default('fast'),
  OPENAI_BACKGROUND_SERVICE_TIER: optionalServiceTier().default('default'),
  /** Hard monthly cap in USD. 0 disables the cap. */
  OPENAI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(10),
  OPENAI_INTERACTIVE_BUDGET_USD: optionalBudget().default(8),
  OPENAI_BRIEFING_BUDGET_USD: optionalBudget().default(2),
  /** Background model work is disabled until a positive budget is configured. */
  OPENAI_BACKGROUND_BUDGET_USD: z.coerce.number().min(0).default(0),

  // Phase 1 policy layer. Off preserves the existing 800/500-token ceilings.
  HERMES_RESPONSE_MODES: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),

  // Phase 5. In-app delivery is safe by default; unattended mailbox polling is
  // separately opt-in because it changes when Graph is accessed.
  HERMES_PROACTIVE_DELIVERY: z.enum(['observe', 'notify']).default('notify'),
  HERMES_PROACTIVE_BACKGROUND: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
  HERMES_PROACTIVE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(15),
  HERMES_EDGE_RUNTIME: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),

  // Secrets
  SESSION_SECRET: optionalSecret(),
  ENCRYPTION_KEY: optionalSecret(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Development only. Serves a fixture mailbox so the assistant can be tried
  // before Microsoft is connected. Refused in production; the UI shows a banner.
  DEMO_MODE: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
});

export type Env = z.infer<typeof schema>;

const injectedEdgeEnvironment = (globalThis as typeof globalThis & {
  __HERMES_EDGE_ENV?: Record<string, string | undefined>;
}).__HERMES_EDGE_ENV ?? {};
const combinedEnvironment = { ...process.env, ...injectedEdgeEnvironment };
const edgeRuntimeInput = combinedEnvironment.HERMES_EDGE_RUNTIME === 'true';
const supabaseUrl = combinedEnvironment.SUPABASE_URL;
const runtimeInput = {
  ...combinedEnvironment,
  NODE_ENV: combinedEnvironment.NODE_ENV ?? (edgeRuntimeInput ? 'production' : undefined),
  APP_URL: combinedEnvironment.APP_URL ?? combinedEnvironment.HERMES_APP_URL,
  API_URL: combinedEnvironment.API_URL ?? (supabaseUrl ? `${supabaseUrl}/functions/v1/api` : undefined),
  DATABASE_URL: combinedEnvironment.DATABASE_URL ?? combinedEnvironment.SUPABASE_DB_URL,
  COOKIE_SAME_SITE: combinedEnvironment.COOKIE_SAME_SITE ?? (edgeRuntimeInput ? 'none' : undefined),
  HERMES_PROACTIVE_DELIVERY: combinedEnvironment.HERMES_PROACTIVE_DELIVERY ?? (edgeRuntimeInput ? 'observe' : undefined),
  HERMES_PROACTIVE_BACKGROUND: combinedEnvironment.HERMES_PROACTIVE_BACKGROUND ?? (edgeRuntimeInput ? 'false' : undefined),
  DEMO_MODE: combinedEnvironment.DEMO_MODE ?? (edgeRuntimeInput ? 'false' : undefined),
};

const parsed = schema.safeParse(runtimeInput);
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

export function productionConfigurationIssues(config: Env): string[] {
  if (config.NODE_ENV !== 'production') return [];
  const issues: string[] = [];
  if (!config.SESSION_SECRET) issues.push('SESSION_SECRET is required in production.');
  if (!config.ENCRYPTION_KEY) issues.push('ENCRYPTION_KEY is required in production.');
  if (config.SESSION_SECRET && config.ENCRYPTION_KEY && config.SESSION_SECRET === config.ENCRYPTION_KEY) {
    issues.push('SESSION_SECRET and ENCRYPTION_KEY must be different.');
  }
  if (!config.DATABASE_URL) issues.push('DATABASE_URL is required in production; in-memory authentication is not permitted.');
  if (!config.PRIMARY_USER_EMAIL && !config.ALLOWED_USERS.trim() && allowedEmailDomains(config.ALLOWED_EMAIL_DOMAINS).length === 0) {
    issues.push('At least one allowed user email or email domain is required in production.');
  }
  if (configuredEmailDomainEntries(config.ALLOWED_EMAIL_DOMAINS).some((domain) => !validEmailDomain(domain))) {
    issues.push('ALLOWED_EMAIL_DOMAINS must contain valid comma-separated email domains.');
  }
  if (config.OPENAI_MONTHLY_BUDGET_USD <= 0) issues.push('OPENAI_MONTHLY_BUDGET_USD must be positive in production.');
  if (new URL(config.APP_URL).origin !== new URL(config.API_URL).origin && config.COOKIE_SAME_SITE !== 'none') {
    issues.push('COOKIE_SAME_SITE must be none when the production web and API origins differ.');
  }
  if (config.HERMES_EDGE_RUNTIME && config.HERMES_PROACTIVE_BACKGROUND) {
    issues.push('HERMES_PROACTIVE_BACKGROUND must be false in the request-driven Edge runtime.');
  }
  return issues;
}

const productionIssues = productionConfigurationIssues(env);
if (productionIssues.length > 0) {
  console.error('Unsafe production configuration. Refusing to start:');
  for (const issue of productionIssues) console.error(`  ${issue}`);
  process.exit(1);
}

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
        ? 'Single-tenant Microsoft sign-in configured'
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
      key: 'openai',
      label: 'OpenAI API',
      ready: Boolean(env.OPENAI_API_KEY),
      detail: env.OPENAI_API_KEY
        ? 'API key configured; effective model roles are reported by the setup API.'
        : 'Add OPENAI_API_KEY after funding your OpenAI API account.',
      action: 'https://platform.openai.com/api-keys',
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
      ready: Boolean(env.PRIMARY_USER_EMAIL || env.ALLOWED_USERS.trim() || allowedEmailDomains().length),
      detail: allowedEmailDomains().length
        ? 'Organisation email-domain allowlist configured'
        : env.PRIMARY_USER_EMAIL || env.ALLOWED_USERS.trim()
          ? 'Named-user allowlist configured'
          : 'Set ALLOWED_EMAIL_DOMAINS or add specific mailbox addresses.',
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

/** Organisation email domains permitted to sign in, lower-cased and deduplicated. */
export function allowedEmailDomains(value = env.ALLOWED_EMAIL_DOMAINS): string[] {
  const domains = configuredEmailDomainEntries(value).filter(validEmailDomain);
  return [...new Set(domains)];
}

function configuredEmailDomainEntries(value: string): string[] {
  return value.split(',')
    .map((item) => item.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

function validEmailDomain(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}

export function emailIsAllowed(
  email: string,
  allowed = allowedUsers(),
  domains = allowedEmailDomains(),
): boolean {
  const normalised = email.trim().toLowerCase();
  if (allowed.map((value) => value.trim().toLowerCase()).includes(normalised)) return true;
  const addressParts = normalised.split('@');
  if (addressParts.length !== 2 || !addressParts[0]) return false;
  const domain = addressParts[1];
  return Boolean(domain && domains.includes(domain));
}

export function redirectUri(): string {
  return env.MICROSOFT_REDIRECT_URI ?? `${env.API_URL}/api/auth/callback`;
}
