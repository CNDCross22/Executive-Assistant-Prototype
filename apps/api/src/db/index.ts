import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Postgres (Supabase Cloud) is optional at boot so the app can start and show
 * an honest setup screen. Everything that needs it checks `hasDb()` first.
 */
let client: postgres.Sql | null = null;

/**
 * Tests must never reach a real database.
 *
 * `npm test` loads .env like everything else, so a developer with a working
 * DATABASE_URL was running the suite against the live Supabase project. Reads
 * merely made the tests slow and flaky; a test that wrote would have written
 * to production data.
 *
 * Under `node --test` the connection is refused and every store falls back to
 * memory, which is what the fallbacks exist for. An integration suite that
 * genuinely needs Postgres opts in explicitly with HERMES_TEST_DATABASE.
 */
const underTest = process.env.NODE_TEST_CONTEXT !== undefined;
const testDatabaseAllowed = process.env.HERMES_TEST_DATABASE === 'true';

if (underTest && !testDatabaseAllowed) {
  if (env.DATABASE_URL) {
    logger.warn('Ignoring DATABASE_URL under test. Set HERMES_TEST_DATABASE=true to opt in deliberately.');
  }
} else if (env.DATABASE_URL) {
  client = postgres(env.DATABASE_URL, {
    // Each Edge isolate owns its own pool. One connection per isolate avoids
    // multiplying connections against Supabase's transaction pooler.
    max: env.HERMES_EDGE_RUNTIME ? 1 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Supabase transaction pooler does not support prepared statements
    onnotice: () => {},
  });
  logger.info('Database configured');
} else {
  logger.warn('DATABASE_URL not set — running with in-memory storage. Sessions will not survive a restart.');
}

export const sql = client;

export function hasDb(): boolean {
  return client !== null;
}

export function requireDb(): postgres.Sql {
  if (!client) throw new Error('Database is not configured.');
  return client;
}

export async function pingDb(): Promise<{ ok: boolean; detail: string }> {
  if (!client) return { ok: false, detail: 'DATABASE_URL not set' };
  try {
    await client`select 1`;
    return { ok: true, detail: 'connected' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'unknown error' };
  }
}

export async function closeDb(): Promise<void> {
  if (client) await client.end({ timeout: 5 });
}
