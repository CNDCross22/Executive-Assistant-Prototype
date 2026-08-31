import type { z } from 'zod';
import type { MailService } from '../../graph/mail.service.js';
import type { UserService } from '../../graph/user.service.js';
import type { CalendarService } from '../../graph/calendar.service.js';
import type { ContactsService } from '../../graph/contacts.service.js';
import type { TasksService } from '../../graph/tasks.service.js';
import type { TeamsService } from '../../graph/teams.service.js';
import type { FilesService } from '../../graph/files.service.js';
import type { StoredUser } from '../../auth/store.js';
import type { RefTable } from '../refs.js';

/**
 * Risk levels drive the approval engine.
 *   0  read-only               — runs automatically
 *   1  low-impact, private     — confirmation required
 *   2  meaningful and external — confirmation required
 *   3  destructive             — always confirmed
 */
export type RiskLevel = 0 | 1 | 2 | 3;
export type ToolCategory = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'memory' | 'identity' | 'directory' | 'mailbox_settings' | 'teams' | 'files' | 'sharepoint';
export type ToolEffect = 'read' | 'create' | 'update' | 'delete' | 'send';
export type ToolIdempotency = 'safe' | 'conditional' | 'unsafe';

export interface ToolMetadata {
  category: ToolCategory;
  effect: ToolEffect;
  changesData: boolean;
  confirmation: 'none' | 'explicit';
  idempotency: ToolIdempotency;
  /** Current Phase 1 tools verify targets while preparing their preview. */
  targetFreshness: 'none' | 'preview' | 'execution';
  privacy: 'metadata' | 'content' | 'sensitive';
}

export interface ActionPreview {
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  warning?: string;
}

export interface ToolContext {
  user: StoredUser;
  mail: MailService;
  users: UserService;
  calendar: CalendarService;
  contacts: ContactsService;
  tasks: TasksService;
  teams: TeamsService;
  files: FilesService;
  /** Her own address, lower-cased. */
  me: string;
  /** Short handles for message ids, so raw ids never reach the model. */
  refs: RefTable;
  conversationId?: string;
  requestId?: string;
  workflowId?: string;
  signal: AbortSignal;
}

export interface Tool<TArgs = unknown> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  metadata: ToolMetadata;
  /** Capability key from config/graphScopes.ts. */
  capability: string;
  schema: z.ZodType<TArgs>;
  /** JSON Schema handed to the model. */
  parameters: Record<string, unknown>;
  /** One line for the activity list the user sees. Never includes content. */
  summarise(args: TArgs): string;
  /** Required at runtime for every non-read-only tool. */
  preview?(args: TArgs, ctx: ToolContext): ActionPreview | Promise<ActionPreview>;
  execute(args: TArgs, ctx: ToolContext): Promise<unknown>;
}

type ToolInput<TArgs> = Omit<Tool<TArgs>, 'metadata'> & { metadata?: Partial<ToolMetadata> };

function categoryFor(name: string): ToolCategory {
  if (name.startsWith('calendar_')) return 'calendar';
  if (name.startsWith('contact')) return 'contacts';
  if (name.startsWith('task')) return 'tasks';
  if (name.startsWith('memory_')) return 'memory';
  if (name.startsWith('profile_')) return 'identity';
  if (name.startsWith('directory_') || name.startsWith('people_')) return 'directory';
  if (name.startsWith('mailbox_settings_')) return 'mailbox_settings';
  if (name.startsWith('teams_')) return 'teams';
  if (name.startsWith('onedrive_')) return 'files';
  if (name.startsWith('sharepoint_')) return 'sharepoint';
  return 'mail';
}

function effectFor(name: string, riskLevel: RiskLevel): ToolEffect {
  if (riskLevel === 0) return 'read';
  if (name.endsWith('_delete') || name === 'memory_forget' || name === 'mail_delete') return 'delete';
  if (/mail_(send|reply|forward|send_draft)/.test(name)) return 'send';
  if (/(create|remember|draft)/.test(name)) return 'create';
  return 'update';
}

function idempotencyFor(name: string, riskLevel: RiskLevel): ToolIdempotency {
  if (riskLevel === 0) return 'safe';
  if (/mail_(send|reply|forward|send_draft)|calendar_create|contact_create|task_create/.test(name)) return 'unsafe';
  return 'conditional';
}

/** One source of truth for tool execution, risk, preview, and operational metadata. */
export function defineTool<TArgs>(tool: ToolInput<TArgs>): Tool<TArgs> {
  const defaults: ToolMetadata = {
    category: categoryFor(tool.name),
    effect: effectFor(tool.name, tool.riskLevel),
    changesData: tool.riskLevel > 0,
    confirmation: tool.riskLevel > 0 ? 'explicit' : 'none',
    idempotency: idempotencyFor(tool.name, tool.riskLevel),
    targetFreshness: tool.riskLevel > 0 ? 'preview' : 'none',
    privacy: /^(mail_|memory_|teams_channel_messages|onedrive_read_text|sharepoint_read_text)/.test(tool.name) ? 'sensitive' : 'metadata',
  };
  return { ...tool, metadata: { ...defaults, ...tool.metadata } } as Tool<TArgs>;
}

/** Helper for the common "object with properties" JSON Schema shape. */
export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
