import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { routeUrl } from '../edge/route-url.js';

/**
 * These cases are recorded from the live Supabase deployment, not derived from
 * the documentation. A previous change to this mapping was reasoned about
 * carefully, deployed, and 404'd every route in production — because the
 * assumption about which `/api` segment was the function name and which was
 * the route prefix was simply wrong.
 *
 * The Edge smoke test cannot catch a regression here: it drives Fastify with
 * `app.inject` using already-correct paths and never calls this function. This
 * file is the only thing standing between a plausible-looking edit and an
 * outage.
 */
describe('Edge path mapping', () => {
  const project = 'https://project.supabase.co';

  test('the shape Supabase actually delivers maps onto a registered route', () => {
    // Observed: the gateway strips /functions/v1 but keeps the function name.
    assert.equal(routeUrl(`${project}/api/api/health`), '/api/health');
    assert.equal(routeUrl(`${project}/api/api/auth/me`), '/api/auth/me');
    assert.equal(routeUrl(`${project}/api/api/graph/notifications`), '/api/graph/notifications');
  });

  test('the fully-qualified function path maps to the same route', () => {
    assert.equal(routeUrl(`${project}/functions/v1/api/api/health`), '/api/health');
    assert.equal(routeUrl(`${project}/functions/v1/api/api/auth/me`), '/api/auth/me');
  });

  test('query strings survive intact, including the Graph validation token', () => {
    assert.equal(
      routeUrl(`${project}/api/api/graph/notifications?validationToken=abc123`),
      '/api/graph/notifications?validationToken=abc123',
    );
    // Graph compares the echoed token byte for byte, so encoding must not shift.
    assert.equal(
      routeUrl(`${project}/api/api/graph/notifications?validationToken=a%20b%2Bc`),
      '/api/graph/notifications?validationToken=a%20b%2Bc',
    );
  });

  test('exactly one /api is removed, never two', () => {
    // The regression: treating the leading /api as the route prefix and
    // keeping it produced /api/api/health, which Fastify does not serve.
    assert.notEqual(routeUrl(`${project}/api/api/health`), '/api/api/health');
    // And over-stripping produced /health, which it also does not serve.
    assert.notEqual(routeUrl(`${project}/api/api/health`), '/health');
  });

  test('the bare function root resolves to a path rather than an empty string', () => {
    assert.equal(routeUrl(`${project}/api`), '/');
    assert.equal(routeUrl(`${project}/functions/v1/api`), '/');
  });

  test('a route that does not begin with the function name is left alone', () => {
    assert.equal(routeUrl(`${project}/health`), '/health');
  });
});
