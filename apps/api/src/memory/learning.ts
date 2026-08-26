/**
 * Preference learning — the honest kind.
 *
 * The temptation is to let the assistant quietly conclude things about her and
 * act on them. Don't. An assistant that develops private opinions about you is
 * unsettling, impossible to audit, and impossible to correct when it is wrong.
 *
 * So learning runs in two stages:
 *
 *   1. OBSERVE  A pattern is noticed and recorded as a *signal*. Signals are
 *               invisible to her and never influence an answer.
 *   2. PROPOSE  Once seen enough times, the signal is raised as a question:
 *               "I have noticed X. Save that?" Only her yes makes it memory.
 *
 * Explicit instructions skip both stages — "never book me before 9" is saved
 * immediately, because she said it.
 */
import { hasDb, requireDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { remember, type MemoryType } from './store.js';

/** How many independent observations before it is worth interrupting her. */
export const PROPOSAL_THRESHOLD = 3;

export interface Observation {
  userId: string;
  /** Stable identity for the pattern so repeats collapse into one signal. */
  signalKey: string;
  type: MemoryType;
  title: string;
  content: string;
  key?: string | null;
  subject?: string | null;
}

/**
 * Record that a pattern was seen. Returns true when it has crossed the
 * threshold and is now waiting for her decision.
 */
export async function observe(o: Observation): Promise<boolean> {
  if (!hasDb()) return false;

  try {
    const db = requireDb();
    const rows = await db<{ observed_count: number; promoted_at: Date | null }[]>`
      insert into memory_signals (user_id, signal_key, type, title, content, key, subject)
      values (${o.userId}, ${o.signalKey}, ${o.type}, ${o.title}, ${o.content}, ${o.key ?? null}, ${o.subject ?? null})
      on conflict (user_id, signal_key) do update set
        observed_count = memory_signals.observed_count + 1,
        last_seen_at   = now()
      returning observed_count, promoted_at
    `;

    const row = rows[0];
    if (!row || row.promoted_at) return false; // already raised with her
    if (row.observed_count < PROPOSAL_THRESHOLD) return false;

    // Threshold crossed: raise it as a proposal, and mark it so she is only
    // asked once even if the pattern keeps recurring.
    await remember({
      userId: o.userId,
      type: o.type,
      title: o.title,
      content: o.content,
      key: o.key ?? null,
      subject: o.subject ?? null,
      source: 'observed',
      confidence: Math.min(0.9, 0.5 + row.observed_count * 0.1),
      status: 'proposed',
      sourceRef: o.signalKey,
    });

    await db`
      update memory_signals set promoted_at = now()
      where user_id = ${o.userId} and signal_key = ${o.signalKey}
    `;

    logger.info({ userId: o.userId, signal: o.signalKey, seen: row.observed_count }, 'Preference proposed');
    return true;
  } catch (err) {
    logger.error({ err }, 'Could not record observation');
    return false;
  }
}

/**
 * Patterns worth watching for.
 *
 * Deliberately narrow. Each one is a phrasing she might actually use, mapped
 * to a specific structured preference. Broad inference is how assistants end
 * up believing nonsense.
 */
interface Detector {
  pattern: RegExp;
  build: (match: RegExpMatchArray) => Omit<Observation, 'userId'> | null;
}

const DETECTORS: Detector[] = [
  {
    // "don't book anything before 9", "no meetings before 8:30"
    pattern: /\b(?:no|don.?t|do not|never)\s+(?:book|schedule|put|arrange)?[^.]{0,20}\b(?:meetings?|anything|calls?)?\s*before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    build: (m) => {
      let hour = Number(m[1]);
      if (m[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (hour < 0 || hour > 23) return null;
      const time = `${String(hour).padStart(2, '0')}:${m[2] ?? '00'}`;
      return {
        signalKey: `preference:workday.start:${time}`,
        type: 'preference',
        key: 'workday.start',
        title: `No meetings before ${time}`,
        content: `Do not schedule anything before ${time}.`,
      };
    },
  },
  {
    // "nothing after 5", "no meetings after 4:30pm"
    pattern: /\b(?:no|don.?t|do not|never|nothing)\s+(?:book|schedule|put|arrange)?[^.]{0,20}\b(?:meetings?|anything|calls?)?\s*after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    build: (m) => {
      let hour = Number(m[1]);
      if (m[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      else if (!m[3] && hour < 8) hour += 12; // "after 5" means 17:00
      if (hour < 0 || hour > 23) return null;
      const time = `${String(hour).padStart(2, '0')}:${m[2] ?? '00'}`;
      return {
        signalKey: `preference:workday.end:${time}`,
        type: 'preference',
        key: 'workday.end',
        title: `Nothing after ${time}`,
        content: `Do not schedule anything after ${time}.`,
      };
    },
  },
  {
    // "keep Friday afternoons free", "protect Wednesday mornings"
    pattern: /\b(?:keep|protect|block|leave)\s+(monday|tuesday|wednesday|thursday|friday)s?\s*(mornings?|afternoons?)?\s*(?:free|clear|blocked|protected)/i,
    build: (m) => {
      const day = m[1]!.toLowerCase();
      const part = m[2]?.toLowerCase().replace(/s$/, '') ?? 'all day';
      return {
        signalKey: `preference:protected.${day}.${part}`,
        type: 'preference',
        key: `protected.${day}`,
        title: `${day[0]!.toUpperCase()}${day.slice(1)} ${part} is protected`,
        content: `Keep ${day} ${part} free of meetings.`,
      };
    },
  },
  {
    // "always ask before sending", "check with me before you send anything"
    pattern: /\b(?:always|please)\s+(?:ask|check with me|confirm)[^.]{0,25}\bbefore\b[^.]{0,25}\b(sending|replying|booking|scheduling|deleting)/i,
    build: (m) => ({
      signalKey: `operational:confirm.${m[1]!.toLowerCase()}`,
      type: 'operational',
      key: `confirm.${m[1]!.toLowerCase()}`,
      title: `Always confirm before ${m[1]!.toLowerCase()}`,
      content: `Ask for explicit approval before ${m[1]!.toLowerCase()} anything.`,
    }),
  },
  {
    // "keep replies short", "I prefer brief emails"
    pattern: /\b(?:keep|make|prefer|i like)\s+(?:my\s+)?(?:replies|emails|responses|messages)\s+(short|brief|concise|to the point)/i,
    build: () => ({
      signalKey: 'working_style:brevity',
      type: 'working_style',
      key: 'style.brevity',
      title: 'Prefers short replies',
      content: 'Keep drafted emails and replies brief and to the point.',
    }),
  },
];

/**
 * Scan a message she sent for patterns worth remembering.
 *
 * Called on every turn. Cheap — pure regex, no model involved — so it costs
 * nothing to run and cannot hallucinate a preference she never expressed.
 */
export async function observeFromMessage(userId: string, message: string): Promise<string[]> {
  const proposed: string[] = [];

  for (const detector of DETECTORS) {
    const match = message.match(detector.pattern);
    if (!match) continue;

    const observation = detector.build(match);
    if (!observation) continue;

    const crossed = await observe({ userId, ...observation });
    if (crossed) proposed.push(observation.title);
  }

  return proposed;
}

/** Signals not yet raised, for the diagnostics view. */
export async function pendingSignals(userId: string): Promise<
  { signalKey: string; title: string; observedCount: number; needed: number }[]
> {
  if (!hasDb()) return [];

  const db = requireDb();
  const rows = await db<{ signal_key: string; title: string; observed_count: number }[]>`
    select signal_key, title, observed_count
    from memory_signals
    where user_id = ${userId} and promoted_at is null
    order by observed_count desc
    limit 20
  `;

  return rows.map((r) => ({
    signalKey: r.signal_key,
    title: r.title,
    observedCount: r.observed_count,
    needed: PROPOSAL_THRESHOLD,
  }));
}
