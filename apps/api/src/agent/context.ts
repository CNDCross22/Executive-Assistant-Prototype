import type { ChatMessage } from '../ai/provider.js';
import type { ActionPreview } from './tools/types.js';

export interface ContextTurn {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  steps?: { tool: string; summary: string; status: 'success' | 'failed' | 'approval_required' }[];
  approval?: { id: string; preview: ActionPreview; expiresAt: string };
}

export interface ActiveActionContext {
  tool: string;
  preview: ActionPreview;
  state: 'being_revised';
}

export interface AssembledContext {
  messages: ChatMessage[];
  recentFacts: string[];
  activeAction?: ActiveActionContext;
  skillQuery: string;
  /**
   * Exact tool names from recent successful steps, newest first.
   *
   * A precise record of what the assistant just did. The prose of a turn is
   * not: it mentions email and messages whatever the subject was, and routing
   * on it drags every follow up towards the same few skills.
   */
  recentTools: string[];
  metrics: {
    candidateMessages: number;
    selectedMessages: number;
    estimatedTokens: number;
    recentFacts: number;
  };
}

const STOP = new Set(['about', 'after', 'again', 'also', 'been', 'before', 'could', 'from', 'have', 'into', 'just', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);
const REFERENCE = /\b(that|it|her|him|them|same|earlier|previous|above|there|tomorrow|instead)\b/i;

function terms(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9@.\s]/g, ' ').split(/\s+/)
      .filter((term) => term.length > 2 && !STOP.has(term)).slice(0, 40),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function estimatedTokens(messages: ChatMessage[], facts: string[]): number {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0) + facts.join('\n').length;
  return Math.ceil(chars / 4);
}

/**
 * Select relevant history rather than blindly replaying the last N turns.
 * Selection is deterministic, content-bounded and cannot authorise an action.
 */
export function assembleContext(args: {
  request: string;
  history: ContextTurn[];
  activeAction?: ActiveActionContext;
  maxMessages?: number;
  maxCharacters?: number;
}): AssembledContext {
  const maxMessages = args.maxMessages ?? 16;
  const maxCharacters = args.maxCharacters ?? 12_000;
  const requestTerms = terms(args.request);
  const hasReference = REFERENCE.test(args.request);
  const candidates = args.history.map((turn, index) => {
    const age = args.history.length - index;
    const recency = age <= 6 ? 20 - age : Math.max(0, 8 - Math.floor(age / 4));
    const relevance = overlap(requestTerms, terms(turn.content)) * 8;
    const reference = hasReference && age <= 10 ? 8 : 0;
    const action = turn.approval || turn.steps?.some((step) => step.status === 'approval_required') ? 12 : 0;
    return { turn, index, score: recency + relevance + reference + action };
  });

  const chosen = new Set<number>();
  // Always preserve the immediate exchange.
  for (let index = Math.max(0, args.history.length - 6); index < args.history.length; index++) chosen.add(index);
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (chosen.size >= maxMessages) break;
    if (candidate.score > 0) chosen.add(candidate.index);
  }

  const ordered = [...chosen].sort((a, b) => a - b);
  const selected: ChatMessage[] = [];
  let characters = 0;
  for (const index of ordered.reverse()) {
    const turn = args.history[index]!;
    if (characters + turn.content.length > maxCharacters && selected.length >= 4) continue;
    selected.unshift({ role: turn.role, content: turn.content });
    characters += turn.content.length;
  }

  const recentFacts: string[] = [];
  const seenFacts = new Set<string>();
  for (const turn of [...args.history].reverse()) {
    for (const step of [...(turn.steps ?? [])].reverse()) {
      if (step.status === 'failed') continue;
      const prefix = step.status === 'approval_required' ? 'Prepared, not executed' : 'Verified result';
      const fact = `${prefix}: ${step.summary}`;
      if (!seenFacts.has(fact)) {
        recentFacts.unshift(fact);
        seenFacts.add(fact);
      }
      if (recentFacts.length >= 6) break;
    }
    if (recentFacts.length >= 6) break;
  }

  const recentTools: string[] = [];
  for (const turn of [...args.history].reverse()) {
    for (const step of turn.steps ?? []) {
      if (step.status !== 'success') continue;
      if (!recentTools.includes(step.tool)) recentTools.push(step.tool);
    }
    if (recentTools.length >= 8) break;
  }

  const messages = selected;
  const contextTerms = messages.slice(-8).map((message) => message.content).join('\n');
  const skillQuery = [args.request, args.request, args.request, args.activeAction?.tool.replaceAll('_', ' '), contextTerms]
    .filter(Boolean).join('\n');

  return {
    messages,
    recentFacts,
    ...(args.activeAction ? { activeAction: args.activeAction } : {}),
    skillQuery,
    recentTools,
    metrics: {
      candidateMessages: args.history.length,
      selectedMessages: messages.length,
      estimatedTokens: estimatedTokens(messages, recentFacts),
      recentFacts: recentFacts.length,
    },
  };
}

export function contextBlock(context: Pick<AssembledContext, 'recentFacts' | 'activeAction'>): string {
  const parts: string[] = [];
  if (context.activeAction) {
    parts.push('ACTIVE ACTION STATE', 'The previous proposal is cancelled and is being revised. It was not executed.', `Action type: ${context.activeAction.tool}`, `Previous preview: ${JSON.stringify(context.activeAction.preview)}`);
  }
  if (context.recentFacts.length) {
    parts.push('RECENT VERIFIED WORKFLOW FACTS', ...context.recentFacts.map((fact) => `- ${fact}`));
  }
  return parts.length ? parts.join('\n') : 'No reusable workflow facts are available for this turn.';
}
