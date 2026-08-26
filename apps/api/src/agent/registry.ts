import type { Tool, ToolContext } from './tools/types.js';
import type { ToolDefinition } from '../ai/provider.js';
import { mailTools } from './tools/mail.tools.js';
import { memoryTools } from './tools/memory.tools.js';
import { isCapabilityEnabled } from '../config/graphScopes.js';
import { Errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const ALL: Tool<never>[] = [...mailTools, ...memoryTools];

/** Only tools whose capability is switched on. */
export function availableTools(): Tool<never>[] {
  return ALL.filter((t) => isCapabilityEnabled(t.capability));
}

export function toolDefinitions(only?: string[]): ToolDefinition[] {
  const tools = availableTools();
  const filtered = only && only.length > 0 ? tools.filter((t) => only.includes(t.name)) : tools;
  // Never leave the model with nothing to call.
  const chosen = filtered.length > 0 ? filtered : tools;

  return chosen.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function findTool(name: string): Tool<never> | undefined {
  return availableTools().find((t) => t.name === name);
}

export interface ToolOutcome {
  name: string;
  summary: string;
  status: 'success' | 'failed';
  result: unknown;
  durationMs: number;
  riskLevel: number;
}

/**
 * Execute one model-requested tool call.
 *
 * The model never touches Microsoft Graph directly. It proposes a name and
 * arguments; we validate them against the tool's schema and refuse anything
 * that does not fit.
 */
export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const started = Date.now();
  const tool = findTool(name);

  if (!tool) {
    return {
      name,
      summary: `Unknown tool: ${name}`,
      status: 'failed',
      result: { error: `There is no tool called "${name}".` },
      durationMs: 0,
      riskLevel: 0,
    };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return {
      name,
      summary: `${name}: arguments were not valid JSON`,
      status: 'failed',
      result: { error: 'Arguments were not valid JSON. Try again with a valid object.' },
      durationMs: Date.now() - started,
      riskLevel: tool.riskLevel,
    };
  }

  const validated = tool.schema.safeParse(parsedArgs);
  if (!validated.success) {
    const detail = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return {
      name,
      summary: `${name}: arguments rejected`,
      status: 'failed',
      result: { error: `Those arguments are not valid. ${detail}` },
      durationMs: Date.now() - started,
      riskLevel: tool.riskLevel,
    };
  }

  const args = validated.data as never;

  // Anything above read-only must go through the approval engine, which is not
  // wired yet. Refuse rather than silently acting.
  if (tool.riskLevel > 0) {
    return {
      name,
      summary: `${tool.summarise(args)} — blocked, approval not enabled yet`,
      status: 'failed',
      result: { error: 'This action needs approval, which is not switched on yet.' },
      durationMs: Date.now() - started,
      riskLevel: tool.riskLevel,
    };
  }

  try {
    const result = await tool.execute(args, ctx);
    const durationMs = Date.now() - started;
    logger.info({ tool: name, durationMs, userId: ctx.user.id }, 'Tool executed');
    return { name, summary: tool.summarise(args), status: 'success', result, durationMs, riskLevel: tool.riskLevel };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message =
      err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : 'Tool failed.';
    logger.warn({ tool: name, durationMs, err }, 'Tool failed');

    // Re-throw auth failures so the whole turn stops and the UI can prompt a reconnect.
    if (err === Errors.needsReauth() || (err as { code?: string }).code === 'needs_reauth') throw err;

    return {
      name,
      summary: `${tool.summarise(args)} — failed`,
      status: 'failed',
      result: { error: message },
      durationMs,
      riskLevel: tool.riskLevel,
    };
  }
}
