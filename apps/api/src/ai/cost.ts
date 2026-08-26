/**
 * Spend tracking and the monthly budget guard.
 *
 * The target is a known number, not a hope: every model call is priced and
 * recorded, and the guard refuses to call the model once the month's budget is
 * spent. Costs are kept in micro-dollars (USD × 1,000,000) so the running
 * total never drifts.
 */
import { env } from '../config/env.js';
import { hasDb, requireDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

/** USD per 1M tokens. Update when the provider changes its rates. */
interface Rate {
  input: number;
  cachedInput: number;
  output: number;
}

const RATES: Record<string, Rate> = {
  // OpenAI
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  // Anthropic
  'claude-haiku-4-5': { input: 1.0, cachedInput: 0.1, output: 5.0 },
  'claude-sonnet-5': { input: 3.0, cachedInput: 0.3, output: 15.0 },
  // Local models cost nothing.
  local: { input: 0, cachedInput: 0, output: 0 },
};

/**
 * `baseUrl` is a parameter rather than a read of the ambient env so that the
 * pricing rules can actually be tested.
 *
 * It used to read `env.AI_BASE_URL` directly, which made the outcome depend on
 * the developer's own .env: with the default Ollama URL an unpriced model came
 * back free, and the test asserting that can never happen failed on any machine
 * without a configured .env. A guard that only holds on one laptop is not a
 * guard.
 */
function rateFor(model: string, baseUrl: string): Rate {
  if (RATES[model]) return RATES[model]!;

  // Local endpoints are free regardless of model name.
  if (/localhost|127\.0\.0\.1/.test(baseUrl)) return RATES.local!;

  // Unknown hosted model: assume the most expensive rate we know so an
  // unpriced model cannot quietly overspend.
  const worst = Object.values(RATES).reduce((a, b) => (b.output > a.output ? b : a));
  logger.warn({ model }, 'No published rate for this model; assuming the highest known rate');
  return worst;
}

export interface Usage {
  promptTokens: number;
  cachedTokens?: number;
  completionTokens: number;
}

/** Cost of one call, in micro-dollars. */
export function costMicros(model: string, usage: Usage, baseUrl: string = env.AI_BASE_URL): number {
  const rate = rateFor(model, baseUrl);
  const cached = usage.cachedTokens ?? 0;
  const fresh = Math.max(0, usage.promptTokens - cached);

  const usd =
    (fresh / 1_000_000) * rate.input +
    (cached / 1_000_000) * rate.cachedInput +
    (usage.completionTokens / 1_000_000) * rate.output;

  return Math.round(usd * 1_000_000);
}

export const formatUsd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;

// ------------------------------------------------------------- recording ---

/** In-memory fallback so tracking still works before the database exists. */
let memorySpendMicros = 0;
let memoryMonth = new Date().getUTCMonth();

export interface RecordArgs {
  userId?: string;
  model: string;
  purpose?: string;
  usage: Usage;
  durationMs?: number;
}

export async function recordUsage(args: RecordArgs): Promise<number> {
  const micros = costMicros(args.model, args.usage);

  if (!hasDb()) {
    const month = new Date().getUTCMonth();
    if (month !== memoryMonth) {
      memoryMonth = month;
      memorySpendMicros = 0;
    }
    memorySpendMicros += micros;
    return micros;
  }

  try {
    const db = requireDb();
    await db`
      insert into ai_usage (user_id, provider, model, purpose, prompt_tokens, cached_tokens, completion_tokens, cost_micros, duration_ms)
      values (
        ${args.userId ?? null}, ${env.AI_PROVIDER}, ${args.model}, ${args.purpose ?? 'chat'},
        ${args.usage.promptTokens}, ${args.usage.cachedTokens ?? 0}, ${args.usage.completionTokens},
        ${micros}, ${args.durationMs ?? null}
      )
    `;
  } catch (err) {
    // Never fail a user's request because bookkeeping failed.
    logger.error({ err }, 'Could not record AI usage');
  }

  return micros;
}

export interface SpendSummary {
  monthToDateMicros: number;
  monthToDate: string;
  budgetMicros: number;
  budget: string;
  percentUsed: number;
  callsThisMonth: number;
  projectedMonthEnd: string;
  overBudget: boolean;
}

export async function spendSummary(): Promise<SpendSummary> {
  const budgetMicros = Math.round(env.AI_MONTHLY_BUDGET_USD * 1_000_000);

  let spent = memorySpendMicros;
  let calls = 0;

  if (hasDb()) {
    try {
      const db = requireDb();
      const rows = await db<{ total: string; calls: string }[]>`
        select coalesce(sum(cost_micros), 0)::text as total, count(*)::text as calls
        from ai_usage where created_at >= date_trunc('month', now())
      `;
      spent = Number(rows[0]?.total ?? 0);
      calls = Number(rows[0]?.calls ?? 0);
    } catch (err) {
      logger.error({ err }, 'Could not read AI spend');
    }
  }

  // Straight-line projection from the month so far.
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const projected = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : spent;

  return {
    monthToDateMicros: spent,
    monthToDate: formatUsd(spent),
    budgetMicros,
    budget: formatUsd(budgetMicros),
    percentUsed: budgetMicros > 0 ? Math.round((spent / budgetMicros) * 100) : 0,
    callsThisMonth: calls,
    projectedMonthEnd: formatUsd(Math.round(projected)),
    overBudget: spent >= budgetMicros,
  };
}

/**
 * Refuse to call the model when the month's budget is spent.
 *
 * Deliberately a hard stop rather than a warning. The deterministic answers
 * keep working either way, so an exhausted budget degrades the assistant
 * rather than breaking it.
 */
export async function assertWithinBudget(): Promise<void> {
  if (env.AI_MONTHLY_BUDGET_USD <= 0) return; // 0 disables the cap

  const summary = await spendSummary();
  if (!summary.overBudget) {
    if (summary.percentUsed >= 80) {
      logger.warn({ spend: summary.monthToDate, budget: summary.budget }, 'AI budget nearly spent');
    }
    return;
  }

  logger.error({ spend: summary.monthToDate, budget: summary.budget }, 'AI budget exhausted; refusing model calls');
  throw new AppError(
    402,
    'budget_exhausted',
    `This month's AI budget of ${summary.budget} is used up.`,
    'Direct answers still work. Raise AI_MONTHLY_BUDGET_USD in .env to continue asking open questions.',
  );
}
