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
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { zipSync } from 'fflate';

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

// --- attachment reading, through a real bundle -------------------------------
//
// PDF.js and the ZIP reader are pulled in lazily, so booting the API bundle
// above proves nothing about them: those modules are never evaluated unless a
// document is actually opened. That is exactly the shape of the last
// deployment failure, where a check passed because it bypassed the code it was
// meant to cover. So bundle the extractor on its own and put a real PDF and a
// real .docx through it.
const extractorBundle = path.resolve('supabase/functions/api/.smoke-documents.mjs');
await esbuild({
  absWorkingDir: process.cwd(),
  entryPoints: ['./apps/api/src/content/documents.ts'],
  outfile: extractorBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  banner: {
    js: "import { createRequire as __hermesCreateRequire } from 'node:module'; const require = __hermesCreateRequire(import.meta.url);",
  },
});

const { extractDocumentText } = await import(pathToFileURL(extractorBundle).href);
const utf8 = (value) => new TextEncoder().encode(value);

const stream = 'BT /F1 12 Tf 72 700 Td (Invoice 4417 total 12,480.00 AUD) Tj ET';
const pdf = utf8(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n' +
  `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n` +
  'trailer<</Root 1 0 R/Size 5>>\n%%EOF',
);
const docx = zipSync({
  'word/document.xml': utf8(
    '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
    '<w:p><w:r><w:t>Service Agreement</w:t></w:r></w:p></w:body></w:document>',
  ),
});

for (const [label, input, expected] of [
  ['PDF text extraction', { bytes: pdf, name: 'invoice.pdf' }, /Invoice 4417/],
  ['Word text extraction', { bytes: docx, name: 'agreement.docx' }, /Service Agreement/],
]) {
  try {
    const { text } = await extractDocumentText(input);
    const ok = expected.test(text);
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(35)} read ${JSON.stringify(text.slice(0, 48))}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${label.padEnd(35)} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await rm(extractorBundle, { force: true });

console.log(failures === 0
  ? '\nEdge bundle boots, routes correctly and reads attachments.'
  : `\n${failures} check(s) failed. Do not deploy this bundle.`);
process.exit(failures === 0 ? 0 : 1);
