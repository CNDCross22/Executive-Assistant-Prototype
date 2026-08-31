import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Postgres (Supabase Cloud) is optional at boot so the app can start and show
 * an honest setup screen. Everything that needs it checks `hasDb()` first.
 */
let client: postgres.Sql | null = null;

if (env.DATABASE_URL) {
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
