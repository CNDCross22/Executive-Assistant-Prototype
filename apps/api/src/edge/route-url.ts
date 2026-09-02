/**
 * Path mapping for the Supabase Edge runtime.
 *
 * This lives in the API workspace, not beside the Deno entry point, for one
 * reason: it must be unit-testable. It previously sat inline in
 * supabase/functions/api/index.ts, where nothing could import it without
 * executing Deno-only globals, so a change to it was verifiable only by
 * deploying — and a wrong change 404'd every route in production.
 *
 * The mapping itself:
 *
 * The function is deployed under the name `api`, and every Hermes route also
 * begins with `/api`. Supabase invokes the function with its name still in the
 * path and the route after it, so a browser request to
 * `<project>.supabase.co/functions/v1/api/api/health` arrives as:
 *
 *     /api/api/health
 *      └┬─┘ └──┬────┘
 *   function   the route Fastify registered
 *
 * Exactly one leading `/api` is removed — the function's own name. The full
 * `/functions/v1/api` form is handled too, for callers that preserve it.
 *
 * This is verified against the live deployment, not inferred. Do not "improve"
 * it on reasoning alone: the smoke test drives Fastify through `app.inject`
 * and never exercises this function, so a regression here is invisible until
 * production. The tests in __tests__/edge-routing.test.ts encode the real
 * observed shapes.
 */

const FUNCTION_PREFIX = '/functions/v1/api';
const RUNTIME_PREFIX = '/api';

export function routeUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const fullPrefixAt = url.pathname.indexOf(FUNCTION_PREFIX);

  // Exactly one prefix identifies the function, never both. Whichever form
  // arrives, what remains after removing it is the route Fastify registered.
  //
  // In practice the gateway rewrites `/functions/v1/api/...` down to
  // `/api/...` before the function sees it, so the second branch is the live
  // path. The first is kept for a direct invocation that preserves the full
  // form — and must not then strip a second time, which would remove the
  // route's own `/api` and 404 everything.
  let path: string;
  if (fullPrefixAt >= 0) {
    path = url.pathname.slice(fullPrefixAt + FUNCTION_PREFIX.length);
  } else if (url.pathname === RUNTIME_PREFIX || url.pathname.startsWith(`${RUNTIME_PREFIX}/`)) {
    path = url.pathname.slice(RUNTIME_PREFIX.length);
  } else {
    path = url.pathname;
  }

  return `${path || '/'}${url.search}`;
}
