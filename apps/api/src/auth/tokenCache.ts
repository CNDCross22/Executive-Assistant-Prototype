import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { hasDb, requireDb } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

/**
 * MSAL's token cache holds the refresh token. It is encrypted at rest and
 * never leaves the server. One cache per user, keyed by our user id.
 */
interface CacheBackend {
  read(userId: string): Promise<string | null>;
  write(userId: string, blob: string): Promise<void>;
  clear(userId: string): Promise<void>;
}

const memory = new Map<string, string>();

const memoryBackend: CacheBackend = {
  async read(userId) {
    return memory.get(userId) ?? null;
  },
  async write(userId, blob) {
    memory.set(userId, blob);
  },
  async clear(userId) {
    memory.delete(userId);
  },
};

const postgresBackend: CacheBackend = {
  async read(userId) {
    const db = requireDb();
    const rows = await db<{ token_cache_encrypted: string | null }[]>`
      select token_cache_encrypted from oauth_connections
      where user_id = ${userId} and provider = 'microsoft' limit 1
    `;
    const blob = rows[0]?.token_cache_encrypted;
    if (!blob) return null;
    try {
      return decryptSecret(blob);
    } catch (err) {
      logger.error({ err }, 'Could not decrypt token cache; forcing re-auth');
      return null;
    }
  },
  async write(userId, blob) {
    const db = requireDb();
    await db`
      insert into oauth_connections (user_id, provider, token_cache_encrypted, status)
      values (${userId}, 'microsoft', ${encryptSecret(blob)}, 'connected')
      on conflict (user_id, provider) do update set
        token_cache_encrypted = excluded.token_cache_encrypted,
        last_refreshed_at     = now(),
        updated_at            = now()
    `;
  },
  async clear(userId) {
    const db = requireDb();
    await db`update oauth_connections set token_cache_encrypted = null, status = 'needs_reauth' where user_id = ${userId}`;
  },
};

function backend(): CacheBackend {
  return hasDb() ? postgresBackend : memoryBackend;
}

/** An MSAL cache plugin scoped to a single user. */
export function cachePluginFor(userId: string): ICachePlugin {
  return {
    async beforeCacheAccess(ctx: TokenCacheContext) {
      const blob = await backend().read(userId);
      if (blob) ctx.tokenCache.deserialize(blob);
    },
    async afterCacheAccess(ctx: TokenCacheContext) {
      if (ctx.cacheHasChanged) {
        await backend().write(userId, ctx.tokenCache.serialize());
      }
    },
  };
}

export async function clearTokenCache(userId: string): Promise<void> {
  await backend().clear(userId);
}

/**
 * During the sign-in redirect we do not yet know our internal user id, so the
 * code exchange runs against a scratch cache which is then copied across.
 */
export function scratchCachePlugin(sink: { blob: string | null }): ICachePlugin {
  return {
    async beforeCacheAccess(ctx: TokenCacheContext) {
      if (sink.blob) ctx.tokenCache.deserialize(sink.blob);
    },
    async afterCacheAccess(ctx: TokenCacheContext) {
      if (ctx.cacheHasChanged) sink.blob = ctx.tokenCache.serialize();
    },
  };
}

export async function adoptScratchCache(userId: string, blob: string): Promise<void> {
  await backend().write(userId, blob);
}
