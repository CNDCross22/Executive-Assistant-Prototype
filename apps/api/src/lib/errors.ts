/** Errors the user is allowed to see, with a stable machine code. */
export class AppError extends Error {
  readonly safeToExpose = true;

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Phrasing matters here: these strings are shown to the Director. They must
 * never imply an action succeeded, never invent a cause, and never expose
 * anything about the machinery behind them.
 */
export const Errors = {
  notConfigured: (what: string) =>
    new AppError(503, 'not_configured', `${what} is not set up yet.`, 'Finish setup and try again.'),

  unauthorized: () => new AppError(401, 'unauthorized', 'You are not signed in.'),

  forbidden: (detail?: string) =>
    new AppError(403, 'forbidden', 'This account is not permitted to use this assistant.', detail),

  invalidOrigin: () =>
    new AppError(403, 'invalid_origin', 'That request did not come from the Hermes interface.'),

  notFound: (what = 'that') => new AppError(404, 'not_found', `I could not find ${what}.`),

  needsReauth: () =>
    new AppError(
      401,
      'needs_reauth',
      'Your Microsoft connection needs to be refreshed.',
      'Sign in again to reconnect.',
    ),

  graphPermission: (_scope: string) =>
    new AppError(
      403,
      'graph_permission',
      'I do not currently have permission to do that.',
      'Reconnect Microsoft 365 to refresh access. Nothing was changed.',
    ),

  graphUnavailable: (_internalDetail?: string) =>
    new AppError(502, 'graph_unavailable', "Microsoft 365 isn't responding right now.", 'Nothing was changed. Try again in a moment.'),

  throttled: (retryAfter?: number) =>
    new AppError(
      429,
      'throttled',
      'Microsoft is rate limiting us. Give it a moment.',
      retryAfter ? `Retry after ${retryAfter}s` : undefined,
    ),

  badRequest: (message: string) => new AppError(400, 'bad_request', message),

  database: () =>
    new AppError(503, 'database_unavailable', 'I could not reach my own records just now.', 'Try again shortly.'),

  internal: (_internalDetail?: string) =>
    new AppError(500, 'internal', 'I could not complete that request.', 'Nothing was changed. Try again in a moment.'),
} as const;

// ------------------------------------------------------------- mapping -----

/** Zod throws across module instances, so identify it by shape, not instanceof. */
function isZodError(err: unknown): err is { issues: { path: (string | number)[]; message: string }[] } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'issues' in err &&
    Array.isArray((err as { issues: unknown }).issues)
  );
}

/**
 * Postgres error classes we can translate into something meaningful.
 * Everything else becomes a generic database error — the raw message must
 * never reach the client, because it describes our schema.
 */
const PG_CLASS: Record<string, () => AppError> = {
  '22P02': () => Errors.notFound('that'), // invalid text representation, e.g. a malformed id
  '23503': () => Errors.badRequest('That refers to something which no longer exists.'),
  '23505': () => Errors.badRequest('That already exists.'),
  '23514': () => Errors.badRequest('That value is not allowed.'),
  '42501': () => Errors.database(), // insufficient privilege
  '57014': () => new AppError(504, 'timeout', 'That query took too long and was stopped.'),
};

function isPgError(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as { code: string }).code)
  );
}

/**
 * Turn anything thrown anywhere into an AppError safe to send to the browser.
 *
 * Written after raw Postgres errors — including our own column types — were
 * observed reaching the client with HTTP 500.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Edge runtimes and request-injection libraries can reconstruct an Error and
  // lose its prototype. Preserve only explicitly branded Hermes errors; a raw
  // object with a statusCode is not trusted and still becomes generic.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { safeToExpose?: unknown }).safeToExpose === true &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    const exposed = err as { statusCode: number; code: string; message: string; detail?: string };
    if (exposed.statusCode >= 400 && exposed.statusCode <= 599 && /^[a-z][a-z0-9_]{1,63}$/.test(exposed.code)) {
      return new AppError(exposed.statusCode, exposed.code, exposed.message, exposed.detail);
    }
  }

  if (isZodError(err)) {
    const detail = err.issues
      .slice(0, 4)
      .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
      .join('; ');
    return new AppError(400, 'bad_request', 'That request was not valid.', detail);
  }

  if (isPgError(err)) {
    const mapped = PG_CLASS[err.code];
    return mapped ? mapped() : Errors.database();
  }

  const message = err instanceof Error ? err.message : String(err);

  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection.*(closed|terminated)/i.test(message)) {
    return Errors.database();
  }

  return Errors.internal();
}

/** True when a string is a well-formed UUID, so we can 404 before querying. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
