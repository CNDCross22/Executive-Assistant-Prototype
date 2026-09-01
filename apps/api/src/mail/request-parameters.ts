export interface MailRequestParameters {
  /** Explicit requested result count. Undefined means the caller should use its normal default. */
  limit?: number;
  /** Explicit lookback window. */
  sinceHours?: number;
  unreadOnly: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function numberValue(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  return NUMBER_WORDS[value.toLowerCase()];
}

/** Deterministic extraction for common natural-language Inbox parameters. */
export function mailRequestParameters(text: string): MailRequestParameters {
  const normalised = text.toLowerCase().replace(/[-–—]/g, ' ');

  let limit: number | undefined;
  if (/\b(?:all|every)\s+(?:my\s+)?(?:emails?|messages?)\b/.test(normalised)) {
    limit = 100;
  } else {
    const count = normalised.match(
      /\b(?:top|first|latest|show|check|list|find|give me)?\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:(?:most|highest)\s+)?(?:(?:important|urgent|priority|recent|latest|unread)\s+)?(?:emails?|messages?)\b/,
    );
    const parsed = count?.[1] ? numberValue(count[1]) : undefined;
    if (parsed !== undefined) limit = bounded(parsed, 1, 100);
  }

  let sinceHours: number | undefined;
  const duration = normalised.match(
    /\b(?:past|last|previous|within|from(?:\s+the)?(?:\s+(?:past|last|previous))?)\s+(?:(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)?(hours?|days?|weeks?|months?)\b/,
  );
  if (duration) {
    const amount = duration[1] ? numberValue(duration[1]) ?? 1 : 1;
    const unit = duration[2] ?? 'hour';
    const multiplier = unit.startsWith('month') ? 24 * 30
      : unit.startsWith('week') ? 24 * 7
        : unit.startsWith('day') ? 24 : 1;
    sinceHours = bounded(amount * multiplier, 1, 24 * 365);
  } else if (/\b(?:today|this morning|this afternoon|this evening)\b/.test(normalised)) {
    sinceHours = 24;
  }

  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(sinceHours !== undefined ? { sinceHours } : {}),
    unreadOnly: /\bunread\b/.test(normalised),
  };
}
