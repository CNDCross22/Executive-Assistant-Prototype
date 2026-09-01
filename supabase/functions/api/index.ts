// Supabase provides these globals in the Edge runtime. Runtime secrets are set
// in the Supabase project and are never compiled into the Pages application.
import { Buffer } from 'node:buffer';
import { Server } from 'node:http';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

// Fastify's production logger uses Buffer through pino/sonic-boom. Deno offers
// the Node implementation as a module but does not install it globally.
(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer ??= Buffer;
(globalThis as typeof globalThis & { global?: typeof globalThis }).global ??= globalThis;
const timerGlobals = globalThis as typeof globalThis & {
  setImmediate?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => number;
  clearImmediate?: (handle: number) => void;
};
timerGlobals.setImmediate ??= (callback, ...args) => setTimeout(callback, 0, ...args);
timerGlobals.clearImmediate ??= (handle) => clearTimeout(handle);

// Fastify configures a timeout on its internal Node server even when requests
// are handled exclusively through inject(). Deno does not implement that
// listener method; no socket is opened in Edge, so retaining the value is a
// safe compatibility no-op.
Server.prototype.setTimeout = function setTimeoutCompat(milliseconds: number) {
  this.timeout = milliseconds;
  return this;
};

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const forwardedKeys = [
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'PRIMARY_USER_EMAIL',
  'ALLOWED_USERS',
  'ALLOWED_EMAIL_DOMAINS',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_FAST_MODEL',
  'OPENAI_EXECUTIVE_MODEL',
  'OPENAI_BRIEFING_MODEL',
  'OPENAI_BACKGROUND_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_FAST_REASONING_EFFORT',
  'OPENAI_EXECUTIVE_REASONING_EFFORT',
  'OPENAI_BRIEFING_REASONING_EFFORT',
  'OPENAI_BACKGROUND_REASONING_EFFORT',
  'OPENAI_SERVICE_TIER',
  'OPENAI_FAST_SERVICE_TIER',
  'OPENAI_EXECUTIVE_SERVICE_TIER',
  'OPENAI_BRIEFING_SERVICE_TIER',
  'OPENAI_BACKGROUND_SERVICE_TIER',
  'OPENAI_MONTHLY_BUDGET_USD',
  'OPENAI_INTERACTIVE_BUDGET_USD',
  'OPENAI_BRIEFING_BUDGET_USD',
  'OPENAI_BACKGROUND_BUDGET_USD',
  'HERMES_RESPONSE_MODES',
  // Real-time mail. Without this the notification URL falls back to the
  // Supabase function URL, which is correct in most deployments but must be
  // overridable when a custom domain fronts the API.
  'HERMES_WEBHOOK_URL',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'LOG_LEVEL',
] as const;
const edgeEnvironment: Record<string, string | undefined> = Object.fromEntries(
  forwardedKeys.map((name) => [name, Deno.env.get(name)]),
);
Object.assign(edgeEnvironment, {
  NODE_ENV: 'production',
  APP_URL: Deno.env.get('HERMES_APP_URL'),
  API_URL: supabaseUrl ? `${supabaseUrl}/functions/v1/api` : undefined,
  DATABASE_URL: Deno.env.get('SUPABASE_DB_URL'),
  SUPABASE_URL: supabaseUrl,
  COOKIE_SAME_SITE: 'none',
  HERMES_EDGE_RUNTIME: 'true',
  HERMES_PROACTIVE_DELIVERY: 'observe',
  HERMES_PROACTIVE_BACKGROUND: 'false',
  DEMO_MODE: 'false',
});
(globalThis as typeof globalThis & { __HERMES_EDGE_ENV?: Record<string, string | undefined> })
  .__HERMES_EDGE_ENV = edgeEnvironment;

// routeUrl comes from the bundle so the deployed shim uses the same
// implementation the unit tests cover. Keeping a second copy here is what
// allowed a wrong edit to reach production unchecked.
const { buildApp, routeUrl } = await import('./hermes-api.mjs');
const app = await buildApp();


Deno.serve(async (request) => {
  const routedUrl = routeUrl(request.url);
  const bodyBytes = ['GET', 'HEAD'].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer());
  const payload = bodyBytes?.byteLength ? bodyBytes : undefined;
  const requestHeaders = Object.fromEntries(request.headers.entries());
  // Supabase's gateway may attach application/json to a bodyless DELETE.
  // Fastify correctly rejects that combination before the route can run, so
  // omit entity headers when there is no entity to parse.
  if (!payload) {
    delete requestHeaders['content-type'];
    delete requestHeaders['content-length'];
  }
  const result = await app.inject({
    method: request.method,
    url: routedUrl,
    headers: requestHeaders,
    payload,
  });

  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }

  // The Fetch standard forbids a body for these statuses. Fastify inject()
  // still exposes an empty Buffer for a CORS 204, and passing that Buffer to
  // Deno's Response constructor throws before the actual browser POST runs.
  const bodyless = request.method === 'HEAD' || [101, 204, 205, 304].includes(result.statusCode);
  return new Response(bodyless ? null : result.rawPayload, { status: result.statusCode, headers });
});
