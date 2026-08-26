import type { z } from 'zod';
import type { MailService } from '../../graph/mail.service.js';
import type { UserService } from '../../graph/user.service.js';
import type { StoredUser } from '../../auth/store.js';
import type { RefTable } from '../refs.js';

/**
 * Risk levels drive the approval engine.
 *   0  read-only               — runs automatically
 *   1  low-impact, private     — runs automatically by default
 *   2  meaningful and external — confirmation required
 *   3  destructive             — always confirmed
 */
export type RiskLevel = 0 | 1 | 2 | 3;

export interface ToolContext {
  user: StoredUser;
  mail: MailService;
  users: UserService;
  /** Her own address, lower-cased. */
  me: string;
  /** Short handles for message ids, so raw ids never reach the model. */
  refs: RefTable;
  signal: AbortSignal;
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  /** Capability key from config/graphScopes.ts. */
  capability: string;
  schema: z.ZodType<TArgs>;
  /** JSON Schema handed to the model. */
  parameters: Record<string, unknown>;
  /** One line for the activity list the user sees. Never includes content. */
  summarise(args: TArgs): string;
  execute(args: TArgs, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<TArgs>(tool: Tool<TArgs>): Tool<TArgs> {
  return tool;
}

/** Helper for the common "object with properties" JSON Schema shape. */
export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
