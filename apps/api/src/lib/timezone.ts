/**
 * Microsoft Graph reports mailbox timezones using Windows names
 * ("AUS Eastern Standard Time"). JavaScript's Intl only understands IANA
 * names ("Australia/Sydney"), and throws a RangeError on anything else.
 *
 * Everything that formats a date for the user goes through `toIana` first.
 */

/** Common Windows zone names to IANA. Extend as new tenants appear. */
const WINDOWS_TO_IANA: Record<string, string> = {
  // Australia / NZ
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'AUS Central Standard Time': 'Australia/Darwin',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'W. Australia Standard Time': 'Australia/Perth',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'New Zealand Standard Time': 'Pacific/Auckland',

  // Asia
  'Singapore Standard Time': 'Asia/Singapore',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'China Standard Time': 'Asia/Shanghai',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'India Standard Time': 'Asia/Kolkata',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Arabian Standard Time': 'Asia/Dubai',
  'Israel Standard Time': 'Asia/Jerusalem',

  // Europe
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',

  // Americas
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'SA Pacific Standard Time': 'America/Bogota',
  'Central America Standard Time': 'America/Guatemala',

  // Africa
  'South Africa Standard Time': 'Africa/Johannesburg',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Egypt Standard Time': 'Africa/Cairo',
  'Morocco Standard Time': 'Africa/Casablanca',

  UTC: 'UTC',
  'UTC-11': 'Etc/GMT+11',
  'UTC-02': 'Etc/GMT+2',
  'UTC+12': 'Etc/GMT-12',
  'UTC+13': 'Etc/GMT-13',
};

/** True when Intl accepts this identifier. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise any timezone identifier to something Intl accepts.
 * Falls back to UTC rather than throwing — a wrong-but-working clock beats a
 * crashed assistant, and the mismatch is logged by the caller.
 */
export function toIana(tz: string | null | undefined): string {
  if (!tz) return 'UTC';

  const trimmed = tz.trim();
  if (isValidTimeZone(trimmed)) return trimmed;

  const mapped = WINDOWS_TO_IANA[trimmed];
  if (mapped && isValidTimeZone(mapped)) return mapped;

  // Case-insensitive retry: Graph capitalisation has varied over time.
  const key = Object.keys(WINDOWS_TO_IANA).find((k) => k.toLowerCase() === trimmed.toLowerCase());
  if (key) {
    const viaKey = WINDOWS_TO_IANA[key];
    if (viaKey && isValidTimeZone(viaKey)) return viaKey;
  }

  return 'UTC';
}

/** Format a date safely, never throwing on a bad zone. */
export function formatInZone(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const zone = toIana(timeZone);
  try {
    return date.toLocaleString('en-GB', { ...options, timeZone: zone });
  } catch {
    return date.toLocaleString('en-GB', { ...options, timeZone: 'UTC' });
  }
}
