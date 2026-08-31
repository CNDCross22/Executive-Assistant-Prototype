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
import type { BudgetCategory, ModelRole } from './policy.js';
import type { ResponseMode } from '../agent/response-policy.js';

/** USD per 1M tokens. Update when OpenAI changes its rates. */
interface Rate {
  input: number;
  cachedInput: number;
  output: number;
}

const RATES: Record<string, Rate> = {
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10.0 },
  'gpt-5.6': { input: 4.0, cachedInput: 0.4, output: 20.0 },
  'gpt-5.6-sol': { input: 4.0, cachedInput: 0.4, output: 20.0 },
  'gpt-5.6-terra': { input: 2.0, cachedInput: 0.2, output: 12.0 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
};

/**
 * Unknown OpenAI models are priced pessimistically so a new model can never
 * bypass the spending guard before its published rate is added here.
 */
function rateFor(model: string): Rate {
  if (RATES[model]) return RATES[model]!;

  // OpenAI responses use dated model snapshots (for example,
  // gpt-5-mini-2025-08-07). Bill those at their stable alias's rate.
  const alias = Object.keys(RATES)
    .sort((a, b) => b.length - a.length)
    .find((name) => model.startsWith(`${name}-20`));
  if (alias) return RATES[alias]!;

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
export function costMicros(model: string, usage: Usage): number {
  const rate = rateFor(model);
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
let memoryPeriod = new Date().toISOString().slice(0, 7);
const memorySpendByCategory: Record<BudgetCategory, number> = { interactive: 0, briefing: 0, background: 0 };
let memoryCalls = 0;

export interface RecordArgs {
  userId?: string;
  model: string;
  purpose?: string;
  budgetCategory?: BudgetCategory;
  requestId?: string;
  conversationId?: string;
  workflowId?: string;
  modelRole?: ModelRole;
  responseMode?: ResponseMode;
  iteration?: number;
  usage: Usage;
  durationMs?: number;
}

export async function recordUsage(args: RecordArgs): Promise<number> {
  const micros = costMicros(args.model, args.usage);
  const budgetCategory = args.budgetCategory ?? (args.purpose === 'briefing' ? 'briefing' : 'interactive');

  if (!hasDb()) {
    const period = new Date().toISOString().slice(0, 7);
    if (period !== memoryPeriod) {
      memoryPeriod = period;
      memorySpendMicros = 0;
      memoryCalls = 0;
      memorySpendByCategory.interactive = 0;
      memorySpendByCategory.briefing = 0;
      memorySpendByCategory.background = 0;
    }
    memorySpendMicros += micros;
    memorySpendByCategory[budgetCategory] += micros;
    memoryCalls++;
    return micros;
  }

  try {
    const db = requireDb();
    await db`
      insert into ai_usage (
        user_id, provider, model, purpose, budget_category, request_id, conversation_id, workflow_id,
        model_role, response_mode, iteration, prompt_tokens, cached_tokens, completion_tokens, cost_micros, duration_ms
      )
      values (
        ${args.userId ?? null}, ${'openai'}, ${args.model}, ${args.purpose ?? 'chat'}, ${budgetCategory},
        ${args.requestId ?? null}, ${args.conversationId ?? null}, ${args.workflowId ?? null},
        ${args.modelRole ?? null}, ${args.responseMode ?? null}, ${args.iteration ?? null},
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
  categories: Record<BudgetCategory, CategorySpendSummary>;
}

export interface CategorySpendSummary {
  monthToDateMicros: number;
  monthToDate: string;
  budgetMicros: number | null;
  budget: string | null;
  percentUsed: number | null;
  overBudget: boolean;
}

export function budgetUsdForCategory(category: BudgetCategory): number | undefined {
  if (category === 'interactive') return env.OPENAI_INTERACTIVE_BUDGET_USD;
  if (category === 'briefing') return env.OPENAI_BRIEFING_BUDGET_USD;
  return env.OPENAI_BACKGROUND_BUDGET_USD;
}

export async function spendSummary(): Promise<SpendSummary> {
  const budgetMicros = Math.round(env.OPENAI_MONTHLY_BUDGET_USD * 1_000_000);

  let spent = memorySpendMicros;
  let calls = memoryCalls;
  const categoryTotals: Record<BudgetCategory, number> = { ...memorySpendByCategory };

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

    try {
      const db = requireDb();
      const rows = await db<{ category: BudgetCategory; total: string }[]>`
        select budget_category as category, coalesce(sum(cost_micros), 0)::text as total
        from ai_usage
        where created_at >= date_trunc('month', now()) and budget_category is not null
        group by budget_category
      `;
      for (const row of rows) {
        if (row.category in categoryTotals) categoryTotals[row.category] = Number(row.total);
      }
    } catch (err) {
      // The global cap still works before migration 0009 is applied.
      logger.debug({ err }, 'Could not read category AI spend');
    }
  }

  // Straight-line projection from the month so far.
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const projected = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : spent;

  const categories = Object.fromEntries(
    (['interactive', 'briefing', 'background'] as const).map((category) => {
      const total = categoryTotals[category];
      const configured = budgetUsdForCategory(category);
      const categoryBudgetMicros = configured === undefined ? null : Math.round(configured * 1_000_000);
      return [category, {
        monthToDateMicros: total,
        monthToDate: formatUsd(total),
        budgetMicros: categoryBudgetMicros,
        budget: categoryBudgetMicros === null ? null : formatUsd(categoryBudgetMicros),
        percentUsed: categoryBudgetMicros && categoryBudgetMicros > 0
          ? Math.round((total / categoryBudgetMicros) * 100)
          : categoryBudgetMicros === null ? null : 0,
        overBudget: categoryBudgetMicros !== null && (categoryBudgetMicros === 0 || total >= categoryBudgetMicros),
      } satisfies CategorySpendSummary];
    }),
  ) as Record<BudgetCategory, CategorySpendSummary>;

  return {
    monthToDateMicros: spent,
    monthToDate: formatUsd(spent),
    budgetMicros,
    budget: formatUsd(budgetMicros),
    percentUsed: budgetMicros > 0 ? Math.round((spent / budgetMicros) * 100) : 0,
    callsThisMonth: calls,
    projectedMonthEnd: formatUsd(Math.round(projected)),
    overBudget: budgetMicros > 0 && spent >= budgetMicros,
    categories,
  };
}

/**
 * Refuse to call the model when the month's budget is spent.
 *
 * Deliberately a hard stop rather than a warning. The deterministic answers
 * keep working either way, so an exhausted budget degrades the assistant
 * rather than breaking it.
 */
export async function assertWithinBudget(category: BudgetCategory = 'interactive'): Promise<void> {
  const summary = await spendSummary();
  if (env.OPENAI_MONTHLY_BUDGET_USD > 0 && !summary.overBudget) {
    if (summary.percentUsed >= 80) {
      logger.warn({ spend: summary.monthToDate, budget: summary.budget }, 'AI budget nearly spent');
    }
  } else if (env.OPENAI_MONTHLY_BUDGET_USD > 0) {
    logger.error({ spend: summary.monthToDate, budget: summary.budget }, 'AI budget exhausted; refusing model calls');
    throw new AppError(
      402,
      'budget_exhausted',
      `This month's AI budget of ${summary.budget} is used up.`,
      'Direct answers still work. Raise OPENAI_MONTHLY_BUDGET_USD in .env to continue asking open questions.',
    );
  }

  const categorySpend = summary.categories[category];
  if (categorySpend.budgetMicros === null || !categorySpend.overBudget) return;

  logger.error({ category, spend: categorySpend.monthToDate, budget: categorySpend.budget }, 'AI category budget exhausted');
  throw new AppError(
    402,
    'category_budget_exhausted',
    category === 'background'
      ? 'Background AI work is disabled by its budget policy.'
      : `The ${category} AI budget is used up.`,
    'Interactive deterministic answers remain available. Adjust the relevant category budget to enable more model calls.',
  );
}
