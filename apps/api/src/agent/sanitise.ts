/**
 * Last line of defence on what reaches the Director.
 *
 * The persona asks the model not to leak internals, use markdown, or pad the
 * answer. A small model complies inconsistently, so compliance is enforced
 * here rather than hoped for.
 *
 * This only removes machinery and padding. It never changes a fact, and it
 * never adds anything.
 */

/** Internal vocabulary that should never appear in an answer. */
const LEAKED_MACHINERY: RegExp[] = [
  /\bmail_[a-z_]+\b/gi,
  /\bmemory_[a-z_]+\b/gi,
  /\bcalendar_[a-z_]+\b/gi,
  /\bthey_?have_?not_?replied_?to_?you\b/gi,
  /\byou_?have_?not_?replied_?to_?them\b/gi,
  /\buntrustedBody\b/gi,
  /\bSECURITY_WARNING\b/gi,
];

/**
 * Openers that announce the plumbing instead of answering.
 *
 * Each is bounded and stops at the first comma — an earlier greedy version
 * ran to the end of the sentence and deleted real facts along with the
 * preamble. Removing information is a worse failure than leaving filler, so
 * these must never be able to reach past the clause they target.
 */
const PREAMBLES: RegExp[] = [
  /^based on (the |your )?(mail |email )?(search|results?|data|lookup)[^,.]{0,40},\s*/i,
  /^according to (the|your)[^,.]{0,40},\s*/i,
  /^(it (seems|appears) that|from what i (can see|found)),?\s*/i,
  /^i (have )?(searched|checked|looked through|retrieved)[^,.]{0,50},\s*/i,
  /^here (is|are) (the|a|what)[^:.]{0,40}:\s*/i,
  /^(sure|certainly|of course|absolutely)[!,.]\s*/i,
];

/** Closing filler that adds nothing. */
const TRAILING_FILLER: RegExp[] = [
  /\s*(please )?(let me know if (you need|there is) anything( else)?|i hope (this|that) helps)[^.]*\.?\s*$/i,
  /\s*(make sure to|be sure to|you (should|may want to|might want to)) (review|check|consider)[^.]*\.\s*$/i,
  /\s*(feel free to|do not hesitate to)[^.]*\.\s*$/i,
  /\s*(this (update |message )?(might|may) be relevant[^.]*\.)\s*$/i,
];

/**
 * A long unbroken token is almost always a Microsoft id that slipped through.
 * Nothing a person would ever want to read.
 */
const LONG_OPAQUE_TOKEN = /["']?[A-Za-z0-9+/=_-]{40,}["']?/g;

export interface SanitiseOptions {
  /** Real message ids to scrub, from the ref table. */
  knownIds?: string[];
}

export function sanitiseReply(raw: string, options: SanitiseOptions = {}): string {
  let text = raw.trim();
  if (!text) return text;

  // 1. Remove any real Microsoft id, even truncated.
  for (const id of options.knownIds ?? []) {
    if (id.length < 20) continue;
    text = text.split(id).join('that message');
    const head = id.slice(0, 30);
    if (head.length >= 20) {
      text = text.replace(new RegExp(`${escapeRegex(head)}[A-Za-z0-9+/=_-]*`, 'g'), 'that message');
    }
  }

  // 2. Remove any remaining long opaque token, and the sentence that hosted it
  //    if it was only there to deliver the id.
  text = text.replace(LONG_OPAQUE_TOKEN, 'that message');
  text = text.replace(
    /[^.!?]*\b(id|identifier|reference)\b[^.!?]*that message[^.!?]*[.!?]\s*/gi,
    '',
  );

  // 3. Strip internal names.
  for (const pattern of LEAKED_MACHINERY) text = text.replace(pattern, '');

  // 4. Drop sentences that tell the user to operate the machinery.
  text = text.replace(/[^.!?]*\byou can (find|read|view|get)[^.!?]*\b(function|tool|id)\b[^.!?]*[.!?]\s*/gi, '');
  text = text.replace(/[^.!?]*\busing the\s+function\b[^.!?]*[.!?]\s*/gi, '');

  // 5. Markdown has no place in spoken-style prose.
  text = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1');

  // 6. Preambles and trailing filler.
  for (const pattern of PREAMBLES) text = text.replace(pattern, '');
  for (const pattern of TRAILING_FILLER) text = text.replace(pattern, '');

  // 7. Tidy the damage.
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Capitalise if a preamble strip left a lowercase opener.
  if (text && /^[a-z]/.test(text)) text = text[0]!.toUpperCase() + text.slice(1);

  return text;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
