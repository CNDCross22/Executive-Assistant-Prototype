import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphClient, graphRetryDelayMs } from '../graph/client.js';
import { emailIsAllowed, env, getSetupStatus, productionConfigurationIssues, type Env } from '../config/env.js';
import { buildApp } from '../app.js';

function production(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    NODE_ENV: 'production',
    SESSION_SECRET: 'session-secret-that-is-long-and-unique-0001',
    ENCRYPTION_KEY: 'encryption-key-that-is-long-and-unique-02',
    DATABASE_URL: 'postgres://example.invalid/hermes',
    PRIMARY_USER_EMAIL: 'director@example.com',
    ALLOWED_USERS: '',
    OPENAI_MONTHLY_BUDGET_USD: 5,
    COOKIE_SAME_SITE: 'none',
    DEMO_MODE: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Phase 7 Microsoft Graph retry safety', () => {
  test('honours Retry-After seconds and dates but caps excessive waits', () => {
    assert.equal(graphRetryDelayMs('5', 1, 0), 5_000);
    assert.equal(graphRetryDelayMs(new Date(8_000).toUTCString(), 1, 0), 8_000);
    assert.equal(graphRetryDelayMs('999999', 1, 0), 30_000);
    assert.equal(graphRetryDelayMs(null, 1, 0), 500);
  });
  test('retries an idempotent GET after a transient service error', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? jsonResponse(503, { error: { code: 'ServiceUnavailable' } })
        : jsonResponse(200, { value: 'ok' });
    }) as typeof fetch;
    try {
      const result = await new GraphClient('token').request<{ value: string }>('/me');
      assert.equal(result.value, 'ok');
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('never retries a mutation after an uncertain server response', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(503, { error: { code: 'ServiceUnavailable' } });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => new GraphClient('token').request('/me/sendMail', { method: 'POST', body: { message: {} }, label: 'mail.send' }),
        (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'graph_unavailable'),
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('allows an explicitly read-only POST such as getSchedule to retry', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? jsonResponse(429, { error: { code: 'TooManyRequests' } })
        : jsonResponse(200, { value: [] });
    }) as typeof fetch;
    try {
      await new GraphClient('token').request('/me/calendar/getSchedule', {
        method: 'POST', body: {}, retry: 'safe', label: 'calendar.getSchedule',
      });
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Phase 7 production identity and configuration', () => {
  test('an empty JSON entity is a safe client error rather than an internal failure', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/health',
        headers: { 'content-type': 'application/json' },
        payload: Buffer.alloc(0),
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'bad_request');
    } finally {
      await app.close();
    }
  });

  test('the Director allowlist fails closed and compares addresses case-insensitively', () => {
    assert.equal(emailIsAllowed('director@example.com', []), false);
    assert.equal(emailIsAllowed('Director@Example.com', ['director@example.com']), true);
    assert.equal(emailIsAllowed('colleague@example.com', ['director@example.com']), false);
  });

  test('public setup details do not disclose the tenant id or Director address', () => {
    const details = getSetupStatus().checks.map((check) => check.detail).join('\n');
    if (env.MICROSOFT_TENANT_ID) assert.equal(details.includes(env.MICROSOFT_TENANT_ID), false);
    if (env.PRIMARY_USER_EMAIL) assert.equal(details.includes(env.PRIMARY_USER_EMAIL), false);
  });

  test('accepts a separated, persistent and budget-limited production configuration', () => {
    assert.deepEqual(productionConfigurationIssues(production()), []);
  });

  test('rejects insecure secrets, in-memory production and an unlimited model budget', () => {
    const shared = 'one-secret-used-for-two-different-purposes';
    const issues = productionConfigurationIssues(production({
      SESSION_SECRET: shared,
      ENCRYPTION_KEY: shared,
      DATABASE_URL: undefined,
      PRIMARY_USER_EMAIL: undefined,
      ALLOWED_USERS: '',
      OPENAI_MONTHLY_BUDGET_USD: 0,
    }));
    assert.ok(issues.some((issue) => issue.includes('must be different')));
    assert.ok(issues.some((issue) => issue.includes('DATABASE_URL')));
    assert.ok(issues.some((issue) => issue.includes('allowed Director')));
    assert.ok(issues.some((issue) => issue.includes('BUDGET')));
  });

  test('requires cross-site production cookies to use SameSite=None', () => {
    const issues = productionConfigurationIssues(production({
      APP_URL: 'https://director.example',
      API_URL: 'https://api.example.net',
      COOKIE_SAME_SITE: 'lax',
    }));
    assert.ok(issues.some((issue) => issue.includes('COOKIE_SAME_SITE')));
  });
});
