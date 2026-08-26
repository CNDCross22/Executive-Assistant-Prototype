import { aiProvider } from '../ai/index.js';
import { assertWithinBudget, recordUsage } from '../ai/cost.js';
import type { ChatMessage } from '../ai/provider.js';
import { systemPrompt, formatToolResult } from './prompt.js';
import { toolDefinitions, executeTool, type ToolOutcome } from './registry.js';
import type { ToolContext } from './tools/types.js';
import { logger } from '../lib/logger.js';
import { AppError, Errors } from '../lib/errors.js';
import { tryFastPath } from './fastpath.js';
import { checkCapability, checkClaims } from './guards.js';
import { recall, markUsed } from '../memory/store.js';
import { observeFromMessage } from '../memory/learning.js';
import { selectSkills, toolsForSkills } from './skills.js';

const MAX_ITERATIONS = 6;
const TURN_TIMEOUT_MS = 300_000; // local models are slow; this is a ceiling, not a target

export interface AgentStep {
  tool: string;
  summary: string;
  status: 'success' | 'failed';
}

export interface AgentResult {
  reply: string;
  steps: AgentStep[];
  iterations: number;
  model: string;
  durationMs: number;
}

export interface AgentInput {
  ctx: ToolContext;
  /** Prior turns, oldest first. Excludes the message being sent now. */
  history: ChatMessage[];
  message: string;
}

/**
 * The bounded agent loop.
 *
 * Hard stops on iteration count and wall-clock time. There is no path by which
 * this runs indefinitely, and no path by which the model reaches Microsoft
 * Graph except through a validated tool.
 */
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const { ctx, history, message } = input;
  const provider = aiProvider();
  const started = Date.now();

  // Asking for something we cannot do must never reach the model, because an
  // agreeable model says yes and then invents the outcome.
  const refused = checkCapability(message);
  if (refused) {
    logger.info({ question: message.slice(0, 60) }, 'Refused: capability not enabled');
    return refused;
  }

  // Watch for stated preferences on every turn. Pure regex, no model, so it
  // costs nothing and cannot invent something she never said.
  void observeFromMessage(ctx.user.id, message);

  // Common questions already have a complete deterministic answer. Sending
  // them through the model costs minutes and adds only phrasing.
  if (history.length === 0) {
    const fast = await tryFastPath(message, ctx);
    if (fast) {
      logger.info({ durationMs: fast.durationMs, question: message.slice(0, 60) }, 'Answered without the model');
      return fast;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, ctx.signal]);

  // What she has told us, retrieved before the prompt is assembled.
  const memories = await recall(ctx.user.id, { query: message, limit: 10 });
  if (memories.length > 0) void markUsed(memories.map((m) => m.id));

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: systemPrompt(ctx.user, new Date(), message, {
        memory: memories.map((m) => ({ type: m.type, title: m.title, content: m.content })),
      }),
    },
    ...history,
    { role: 'user', content: message },
  ];

  const steps: AgentStep[] = [];
  const tools = toolDefinitions(toolsForSkills(selectSkills(message)));

  try {
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      // Hard stop before spending, not after.
      await assertWithinBudget();

      let result;
      const callStarted = Date.now();
      try {
        result = await provider.chat({ messages, tools, signal, temperature: 0.3, maxTokens: 500 });
      } catch (err) {
        throw toFriendlyAiError(err);
      }

      if (result.usage) {
        void recordUsage({
          userId: ctx.user.id,
          model: result.model,
          purpose: 'chat',
          usage: result.usage,
          durationMs: Date.now() - callStarted,
        });
      }

      // No tool calls means the model is answering.
      if (result.toolCalls.length === 0) {
        const raw = result.content.trim();

        // Last gate: never pass on a claim of action that nothing backs up.
        const checked = checkClaims(raw, steps);
        if (checked.blocked) {
          logger.error({ reason: checked.reason, raw: raw.slice(0, 200) }, 'Blocked an unbacked action claim');
        }

        return {
          reply: checked.reply || 'I could not put an answer together for that. Could you rephrase it?',
          steps,
          iterations: iteration,
          model: result.model,
          durationMs: Date.now() - started,
        };
      }

      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

      // Tool calls in one round are independent, so run them together.
      const outcomes: ToolOutcome[] = await Promise.all(
        result.toolCalls.map((call) => executeTool(call.name, call.arguments, { ...ctx, signal })),
      );

      result.toolCalls.forEach((call, i) => {
        const outcome = outcomes[i]!;
        steps.push({ tool: outcome.name, summary: outcome.summary, status: outcome.status });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: formatToolResult(outcome.name, outcome.result, outcome.status === 'failed'),
        });
      });

      logger.debug({ iteration, tools: outcomes.map((o) => o.name) }, 'Agent iteration');
    }

    // Ran out of iterations. Say so rather than inventing a conclusion.
    return {
      reply:
        'I looked into that but could not settle on an answer within a reasonable number of steps. ' +
        'Could you narrow it down a little?',
      steps,
      iterations: MAX_ITERATIONS,
      model: provider.model,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toFriendlyAiError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const provider = aiProvider();

  if (/abort/i.test(message)) {
    return new AppError(504, 'ai_timeout', 'That took too long and I stopped it.', 'The model did not finish in time.');
  }

  if (/ECONNREFUSED|fetch failed|ENOTFOUND|socket hang up/i.test(message)) {
    return new AppError(
      503,
      'ai_unreachable',
      'I cannot reach the AI model.',
      `Nothing is answering at ${provider.model}'s endpoint. If you are running Ollama locally, check it is started.`,
    );
  }

  if (/404|not found|model/i.test(message) && /model/i.test(message)) {
    return new AppError(
      503,
      'ai_model_missing',
      `The model "${provider.model}" is not installed.`,
      `Run: ollama pull ${provider.model}`,
    );
  }

  logger.error({ err }, 'AI provider error');
  return Errors.internal(message.slice(0, 200));
}
