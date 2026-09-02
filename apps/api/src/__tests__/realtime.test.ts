import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { clientStateMatches, resetScanScheduling } from '../realtime/notifications.js';
import { clientStateHash } from '../realtime/store.js';
import { notificationUrl, realtimeAvailable } from '../realtime/subscriptions.js';

/**
 * Real-time mail introduces the only unauthenticated mutating endpoint in the
 * application. These tests cover the boundary rather than the happy path: what
 * the webhook accepts, what it refuses, and what it must never do slowly.
 */

afterEach(() => resetScanScheduling());

describe('Phase 1 notification authenticity', () => {
  test('clientState is matched by hash, never by the stored secret', () => {
    const secret = 'a-random-client-state-value';
    const stored = clientStateHash(secret);

    assert.notEqual(stored, secret, 'the secret itself must never be what we store');
    assert.equal(clientStateMatches(secret, stored), true);
  });

  test('a wrong, empty or absent clientState is refused', () => {
    const stored = clientStateHash('the-real-value');

    assert.equal(clientStateMatches('the-wrong-value', stored), false);
    assert.equal(clientStateMatches('', stored), false);
    assert.equal(clientStateMatches(undefined, stored), false);
  });

  test('a clientState of a different length cannot short-circuit the comparison', () => {
    const stored = clientStateHash('value');
    assert.equal(clientStateMatches('x', stored), false);
    assert.equal(clientStateMatches('x'.repeat(500), stored), false);
  });
});

describe('Phase 1 notification endpoint', () => {
  test('answers the Graph validation handshake verbatim as plain text', async () => {
    const app = await buildApp();
    try {
      const token = 'Validation: testing the webhook 123';
      const response = await app.inject({
        method: 'POST',
        url: `/api/graph/notifications?validationToken=${encodeURIComponent(token)}`,
      });

      assert.equal(response.statusCode, 200);
      // Graph compares this byte for byte and rejects the subscription on any
      // difference, including a JSON wrapper or a trailing newline.
      assert.equal(response.body, token);
      assert.match(response.headers['content-type'] as string, /text\/plain/);
    } finally {
      await app.close();
    }
  });

  test('accepts a well-formed batch without acting on unverified notifications', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/graph/notifications',
        payload: {
          value: [
            {
              subscriptionId: 'not-a-subscription-we-made',
              clientState: 'guessed',
              changeType: 'created',
              resourceData: { id: 'AAMkAD' },
            },
          ],
        },
      });

      // Accepted as a batch, but nothing in it was trusted. Returning an error
      // would only make Microsoft redeliver a notification we have rejected.
      assert.equal(response.statusCode, 202);
    } finally {
      await app.close();
    }
  });

  test('refuses a payload that is not a notification batch', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/graph/notifications',
        payload: { unexpected: true },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'bad_request');
    } finally {
      await app.close();
    }
  });

  test('the webhook is reachable without a session, unlike every other mutation', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/graph/notifications',
        payload: { value: [] },
      });
      assert.equal(response.statusCode, 202);
      assert.notEqual(response.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

describe('Phase 1 subscription safety', () => {
  test('a non-public notification URL disables real-time rather than failing silently', () => {
    // The default in development is a loopback API URL, which Graph can never
    // reach. Real-time must report itself unavailable so polling continues.
    const url = notificationUrl();
    if (url === null) {
      assert.equal(realtimeAvailable(), false);
    } else {
      assert.match(url, /^https:/);
      assert.doesNotMatch(url, /localhost|127\.0\.0\.1|\[?::1\]?/);
    }
  });
});
