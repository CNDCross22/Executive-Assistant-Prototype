export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

export interface DirectoryPerson {
  name: string;
  email: string;
  jobTitle: string | null;
}

/** Find the unfinished @mention immediately before the caret. */
export function mentionAtCaret(value: string, caret: number): MentionQuery | null {
  const beforeCaret = value.slice(0, Math.max(0, caret));
  const at = beforeCaret.lastIndexOf('@');
  if (at < 0) return null;

  const preceding = at > 0 ? beforeCaret[at - 1] : '';
  if (preceding && !/[\s([{'"\u201c\u2018]/.test(preceding)) return null;

  const fragment = beforeCaret.slice(at + 1);
  if (fragment.includes('\n') || fragment.length > 80 || /[<>]/.test(fragment)) return null;

  return { start: at, end: caret, query: fragment.trim() };
}

/** Insert both the friendly name and exact address so actions are unambiguous. */
export function insertMention(
  value: string,
  mention: MentionQuery,
  person: DirectoryPerson,
): { value: string; caret: number } {
  const replacement = `@${person.name} <${person.email}>`;
  const needsSpace = value.slice(mention.end).startsWith(' ') ? '' : ' ';
  const next = value.slice(0, mention.start) + replacement + needsSpace + value.slice(mention.end);
  return { value: next, caret: mention.start + replacement.length + needsSpace.length };
}
