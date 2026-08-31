import { Errors, AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Extra headers, e.g. Prefer for timezone or immutable ids. */
  headers?: Record<string, string>;
  /** For logging and audit only. */
  label?: string;
  /** Explicitly marks a non-GET operation as safe to retry. Mutations never retry by default. */
  retry?: 'safe' | 'never';
}

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

export function graphRetryDelayMs(retryAfter: string | null, attempt: number, now = Date.now()): number {
  let requested = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) requested = seconds * 1_000;
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) requested = Math.max(0, date - now);
    }
  }
  const fallback = 2 ** attempt * 250;
  return Math.min(Math.max(requested || fallback, 100), 30_000);
}

/**
 * Thin typed wrapper over Microsoft Graph.
 *
 * Everything Graph-shaped stops here. Services above return application
 * objects, so no Graph response shape ever reaches a route or the agent.
 */
export class GraphClient {
  constructor(
    private readonly accessToken: string,
    private readonly ctx: { userId: string; requestId?: string } = { userId: 'unknown' },
  ) {}

  async request<T>(path: string, options: GraphRequestOptions = {}): Promise<T> {
    const { method = 'GET', query, body, headers = {}, label } = options;

    const url = new URL(path.startsWith('http') ? path : `${GRAPH_BASE}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const started = Date.now();
    const retrySafe = options.retry === 'safe' || (options.retry !== 'never' && method === 'GET');
    const maxAttempts = retrySafe ? 3 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'network error';
        logger.error({ ...this.ctx, label, detail }, 'Graph request failed');
        throw Errors.graphUnavailable(detail);
      }

      // Only idempotent reads retry. A send/create/update with an uncertain
      // outcome must return to the approval engine and be checked manually.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const waitMs = graphRetryDelayMs(res.headers.get('Retry-After'), attempt);
        logger.warn({ ...this.ctx, label, status: res.status, waitMs, attempt }, 'Graph retry');
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if ((res.status === 429 || res.status >= 500) && !retrySafe) {
        logger.warn({ ...this.ctx, label, status: res.status }, 'Graph mutation not retried');
      }

      const durationMs = Date.now() - started;

      if (!res.ok) {
        throw await this.toAppError(res, label, durationMs);
      }

      logger.debug({ ...this.ctx, label, status: res.status, durationMs }, 'Graph ok');

      // sendMail returns 202 with no body; deletes and some updates return 204.
      if (res.status === 202 || res.status === 204 || res.headers.get('content-length') === '0') {
        return undefined as T;
      }
      return (await res.json()) as T;
    }

    throw Errors.graphUnavailable('Exhausted retries.');
  }

  /** Read bounded binary content. Intended only for safe, read-only file retrieval. */
  async requestBytes(
    path: string,
    options: Omit<GraphRequestOptions, 'method' | 'body'> & { maxBytes: number },
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const { query, headers = {}, label, maxBytes } = options;
    const url = new URL(path.startsWith('http') ? path : `${GRAPH_BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let res: Response;
    const started = Date.now();
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: '*/*', ...headers },
        signal: AbortSignal.timeout(20_000),
        redirect: 'manual',
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'network error';
      logger.error({ ...this.ctx, label, detail }, 'Graph content request failed');
      throw Errors.graphUnavailable(detail);
    }
    // Graph file endpoints commonly redirect to a short-lived download URL.
    // Follow it without the bearer token so the Graph credential can never be
    // forwarded to a storage host.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw Errors.graphUnavailable('Graph returned a redirect without a location.');
      const download = new URL(location, url);
      if (download.protocol !== 'https:') throw Errors.graphUnavailable('Graph returned an unsafe download location.');
      try {
        res = await fetch(download, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'download network error';
        throw Errors.graphUnavailable(detail);
      }
    }
    if (!res.ok) throw await this.toAppError(res, label, Date.now() - started);

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new AppError(413, 'file_too_large', 'That file is too large to inspect safely.', `The current limit is ${maxBytes} bytes.`);
    }

    const reader = res.body?.getReader();
    if (!reader) return { bytes: new Uint8Array(), contentType: res.headers.get('content-type') ?? '' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new AppError(413, 'file_too_large', 'That file is too large to inspect safely.', `The current limit is ${maxBytes} bytes.`);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    logger.debug({ ...this.ctx, label, status: res.status, durationMs: Date.now() - started, bytes: total }, 'Graph content ok');
    return { bytes, contentType: res.headers.get('content-type') ?? '' };
  }

  private async toAppError(res: Response, label: string | undefined, durationMs: number): Promise<AppError> {
    let code = '';
    let message = '';
    try {
      const parsed = (await res.json()) as GraphErrorBody;
      code = parsed.error?.code ?? '';
      message = parsed.error?.message ?? '';
    } catch {
      message = await res.text().catch(() => '');
    }

    logger.error({ ...this.ctx, label, status: res.status, code, durationMs }, 'Graph error');

    switch (res.status) {
      case 401:
        return Errors.needsReauth();
      case 403:
        return Errors.graphPermission(code || 'unknown');
      case 404:
        return new AppError(404, 'not_found', 'I could not find that in Microsoft 365.');
      case 429:
        return Errors.throttled(Number(res.headers.get('Retry-After') ?? 0) || undefined);
      default:
        return Errors.graphUnavailable(`${res.status} ${code}`.trim());
    }
  }

  /** Follow @odata.nextLink up to `maxPages`. */
  async collect<T>(path: string, options: GraphRequestOptions = {}, maxPages = 5): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    let page = 0;

    while (next && page < maxPages) {
      const res: { value?: T[]; '@odata.nextLink'?: string } = await this.request(
        next,
        page === 0 ? options : { headers: options.headers, label: options.label },
      );
      if (res.value) out.push(...res.value);
      next = res['@odata.nextLink'];
      page++;
    }

    return out;
  }
}
