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
}

interface GraphErrorBody {
  error?: { code?: string; message?: string };
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
    const maxAttempts = 3;

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

      // Throttling and transient server errors: back off and retry.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 250;
        logger.warn({ ...this.ctx, label, status: res.status, waitMs, attempt }, 'Graph retry');
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const durationMs = Date.now() - started;

      if (!res.ok) {
        throw await this.toAppError(res, label, durationMs);
      }

      logger.debug({ ...this.ctx, label, status: res.status, durationMs }, 'Graph ok');

      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }

    throw Errors.graphUnavailable('Exhausted retries.');
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
        return new AppError(404, 'not_found', 'I could not find that in Microsoft 365.', message);
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
