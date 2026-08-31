/**
 * Enforcement, not instruction.
 *
 * The system prompt tells the model it cannot act and must never claim it did.
 * A small, agreeable model ignores both — it once reported six calendar
 * reminders it had invented, dated 2023, none of which existed.
 *
 * So the rule is enforced here: every claim of having acted is checked
 * against what actually executed. An unbacked claim never reaches the user.
 */
import type { AgentResult, AgentStep } from './orchestrator.js';

/** Capability switches are enforced by the registry; supported requests proceed. */
export function checkCapability(_message: string): AgentResult | null {
  return null;
}

/**
 * A mutation request must result in a real tool-backed approval, never a
 * model-written imitation of one. Deliberately limited to clear action verbs.
 */
export function isActionRequest(message: string): boolean {
  const text = message.toLowerCase();
  const directPatterns = [
    /\b(add|remove|invite)\b.{0,60}\b(attendee|guest|participant)s?\b/,
    /\b(add|append|update|change|edit|set|replace)\b.{0,60}\b(note|notes|description|details|body)\b/,
    /\b(send|reply|respond|forward|draft|compose)\b.{0,60}\b(email|mail|message|reply)?\b/,
    /\b(create|add|book|schedule|reschedule|update|edit|change|move|delete|cancel|accept|decline|tentatively accept)\b.{0,60}\b(calendar|event|meeting|appointment|invitation)s?\b/,
    /\b(create|add|update|edit|change|complete|delete|remove)\b.{0,60}\b(task|reminder|to-do|todo)s?\b/,
    /\b(create|add|update|edit|change|delete|remove)\b.{0,60}\b(contact)s?\b/,
    /\b(mark|flag|unflag|archive|move|delete)\b.{0,60}\b(email|mail|message|it|this|that)\b/,
    /\b(turn on|turn off|enable|disable|set|update|change)\b.{0,60}\b(out of office|automatic repl|auto.?repl|working hours|mailbox setting)/,
    /\b(remember|forget)\b.{0,80}\b(this|that|my|preference|memory|rule|fact|person)\b/,
  ];
  return directPatterns.some((pattern) => pattern.test(text)) || isDurableMemoryStatement(message);
}

/** Clear first-person preferences and standing rules deserve a memory preview. */
export function isDurableMemoryStatement(message: string): boolean {
  const text = message.trim().toLowerCase();
  const patterns = [
    /\bremember\s+(?:that\s+)?(?:i|my|we|our)\b/,
    /\bfrom now on\b/,
    /\bmy preference is\b/,
    /\bi (?:strongly )?prefer\b/,
    /\bi (?:do not|don't) (?:like|want)\b/,
    /\bi want you to (?:always|never)\b/,
    /\bplease (?:always|never)\b/,
    /\balways (?:ask|check|confirm|use|keep|show|write|format|address|call)\b/,
    /\bnever (?:send|reply|book|schedule|delete|use|write|address|call)\b/,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/** A pending proposal may be amended in natural language without starting over. */
export function isApprovalRevisionRequest(message: string): boolean {
  const text = message.trim().toLowerCase();
  return /^(actually\b|also\b|and\b|instead\b|change\b|edit\b|update\b|add\b|remove\b|replace\b|use\b|set\b|make\b|include\b|leave out\b|try again\b|do it again\b|let['’]?s do it again\b|i (?:also )?(?:want|need|would like)\b)/.test(text);
}

/** Confirmation language is reserved for real approval cards created by code. */
export function looksLikeApprovalPrompt(reply: string): boolean {
  const patterns = [
    /please\s+(reply|say|choose|select)\s+yes.{0,40}\b(no|cancel)\b/i,
    /would you like me to proceed/i,
    /\bdo you want me to proceed\b/i,
    /\b(?:should|shall) i proceed\b/i,
    /\bproceed\b.{0,80}\bconfirmation card\b/is,
    /\bneeds? your (explicit )?(approval|confirmation)\b/i,
    /\bpreview\b.{0,80}\bplease confirm\b/is,
    /\bconfirm (this|the) (change|action|update|send|meeting|event|email|task)/i,
  ];
  return patterns.some((pattern) => pattern.test(reply));
}

/** Internal workflow belongs in code and logs, never in a Director-facing reply. */
export function looksLikeInternalProcess(reply: string): boolean {
  const patterns = [
    /\b(?:calendar|mail|email|memory|contact|task|write|read) tool\b/i,
    /\bregistered (?:write|read)?\s*tool\b/i,
    /\btool call\b/i,
    /\b(?:the )?system (?:shows?|creates?|generates?|needs?)\b.{0,60}\b(?:approval|confirmation|card)\b/is,
    /\bI (?:must|need to|cannot|can't)\b.{0,100}\btool\b/is,
  ];
  return patterns.some((pattern) => pattern.test(reply));
}

/** Phrases that assert something was done to the outside world. */
const ACTION_CLAIMS: RegExp[] = [
  /\bI(?:'ve| have)?\s+(added|created|scheduled|booked|set up|set|put)\b[^.]{0,40}\b(reminder|event|meeting|calendar|diary|appointment)/i,
  /\bI(?:'ve| have)?\s+(sent|replied|responded|forwarded|emailed)\b/i,
  /\bI(?:'ve| have)?\s+(deleted|archived|moved|filed|flagged|marked)\b/i,
  /\bI(?:'ve| have)?\s+(drafted|saved)\b[^.]{0,30}\b(draft|email|reply)/i,
  /\bhere are the (reminders|events|meetings|drafts) I(?:'ve| have)\s+(added|created|made)/i,
  /\b(has been|have been|is now)\s+(added|created|scheduled|sent|booked)\b/i,
  /\b(done|sorted|all set)\b.{0,20}\b(calendar|diary|sent|added)\b/i,
  /\bI(?:'ve| have)?\s+(accepted|declined|tentatively accepted)\b[^.]{0,50}\b(meeting|invitation|event)\b/i,
  /\bI(?:'ve| have)?\s+(updated|changed|edited)\b[^.]{0,50}\b(event|meeting|calendar|contact|task|settings?)\b/i,
  /\bI(?:'ve| have)?\s+(added|removed)\b[^.]{0,50}\b(attendee|guest|participant)\b/i,
  /\bI(?:'ve| have)?\s+(completed|deleted|created)\b[^.]{0,50}\b(task|reminder|contact)\b/i,
  /\bI(?:'ve| have)?\s+(remembered|forgotten|saved)\b[^.]{0,50}\b(preference|rule|memory|fact)\b/i,
  /\bI(?:'ve| have)?\s+(enabled|disabled|turned on|turned off)\b[^.]{0,50}\b(out of office|automatic repl|auto.?repl)\b/i,
];

const WRITE_TOOLS = new Set<string>([
  'mail_create_draft', 'mail_create_reply_draft', 'mail_send', 'mail_reply', 'mail_forward', 'mail_send_draft',
  'mail_change_state', 'mail_move', 'mail_delete', 'mailbox_settings_update',
  'calendar_create', 'calendar_update', 'calendar_delete',
  'calendar_respond',
  'contact_create', 'contact_update', 'contact_delete',
  'task_create', 'task_update', 'task_delete', 'memory_remember', 'memory_forget',
]);

function anyWriteHappened(steps: AgentStep[]): boolean {
  return steps.some((s) => WRITE_TOOLS.has(s.tool) && s.status === 'success');
}

export interface ClaimCheck {
  blocked: boolean;
  reply: string;
  reason?: string;
}

/**
 * Refuse to pass on a claim of action that nothing backs up.
 *
 * This is the last gate before the Director reads it. An assistant that says
 * it did something it did not do is worse than useless — it is a liability.
 */
export function checkClaims(reply: string, steps: AgentStep[]): ClaimCheck {
  if (anyWriteHappened(steps)) return { blocked: false, reply };

  const matched = ACTION_CLAIMS.find((p) => p.test(reply));
  if (!matched) return { blocked: false, reply };

  return {
    blocked: true,
    reason: `unbacked action claim matched ${matched.source.slice(0, 40)}`,
    reply:
      'I started to tell you I had done something, and I had not. Nothing has been changed. ' +
      'I will only report a change after the approved Microsoft 365 action succeeds.',
  };
}
