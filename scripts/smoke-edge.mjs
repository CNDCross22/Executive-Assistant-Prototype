#!/usr/bin/env node
/**
 * Boot the Edge bundle and exercise the routes that must never break.
 *
 * The bundle is what actually gets deployed, and until now nothing ever
 * started it outside production. A bundling regression — a missing shim, a
 * dependency that assumes CommonJS — was discoverable only by the Director
 * finding the app dead.
 *
 * This reproduces the Edge runtime's environment injection faithfully, because
 * the bundle behaves differently without it. In particular `NODE_ENV` must be
 * production: the development logger uses pino-pretty, whose worker loader
 * needs `__dirname` and throws on import inside an ES module bundle.
 *
 *   npm run smoke:edge
 *
 * Values below are placeholders that satisfy the production configuration
 * guard. No real secret is needed and none is read.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = path.resolve('supabase/functions/api/hermes-api.mjs');

// Mirrors supabase/functions/api/index.ts. Kept in step with it deliberately:
// if that file starts forwarding a new variable, this should too.
globalThis.__HERMES_EDGE_ENV = {
  NODE_ENV: 'production',
  APP_URL: 'https://example.github.io',
  API_URL: 'https://project.supabase.co/functions/v1/api',
  SUPABASE_URL: 'https://project.supabase.co',
  DATABASE_URL: 'postgres://smoke:smoke@127.0.0.1:5432/smoke',
  COOKIE_SAME_SITE: 'none',
  HERMES_EDGE_RUNTIME: 'true',
  HERMES_PROACTIVE_DELIVERY: 'observe',
  HERMES_PROACTIVE_BACKGROUND: 'false',
  DEMO_MODE: 'false',
  ALLOWED_EMAIL_DOMAINS: 'example.com',
  OPENAI_MONTHLY_BUDGET_USD: '10',
  SESSION_SECRET: 'smoke-test-session-secret-value-0000000001',
  ENCRYPTION_KEY: 'smoke-test-encryption-key-value-0000000002',
  // 'fatal' is the quietest level the schema accepts; 'silent' is rejected.
  LOG_LEVEL: 'fatal',
};

const { buildApp } = await import(pathToFileURL(bundle).href);
const app = await buildApp();

/** [method, path, payload, expected status, why it matters] */
const checks = [
  ['GET', '/api/health', null, 200, 'liveness'],
  ['GET', '/api/setup', null, 200, 'setup screen renders'],
  ['POST', '/api/graph/notifications?validationToken=probe', null, 200, 'Graph subscription handshake'],
  ['POST', '/api/graph/notifications', { value: [] }, 202, 'notification batch accepted'],
  ['GET', '/api/dashboard', null, 401, 'protected routes still require a session'],
  ['GET', '/api/nope', null, 404, 'unknown routes 404 rather than crash'],
];

let failures = 0;
for (const [method, url, payload, expected, why] of checks) {
  let status = 0;
  let detail = '';
  try {
    const response = await app.inject(payload === null ? { method, url } : { method, url, payload });
    status = response.statusCode;
    if (url.includes('validationToken')) {
      // Graph compares this byte for byte; a JSON wrapper fails the handshake.
      if (response.body !== 'probe') {
        detail = ` handshake echoed ${JSON.stringify(response.body)}, expected "probe"`;
      }
    }
  } catch (error) {
    detail = ` threw: ${error instanceof Error ? error.message : String(error)}`;
  }

  const ok = status === expected && detail === '';
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${method.padEnd(4)} ${url.split('?')[0].padEnd(30)} ${status} (want ${expected})  ${why}${detail}`);
}

await app.close();

console.log(failures === 0
  ? '\nEdge bundle boots and routes correctly.'
  : `\n${failures} check(s) failed. Do not deploy this bundle.`);
process.exit(failures === 0 ? 0 : 1);
