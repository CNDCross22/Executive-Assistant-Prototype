import { hasDb, requireDb } from '../db/index.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

export interface StoredUser {
  id: string;
  msUserId: string;
  email: string;
  displayName: string;
  jobTitle: string | null;
  timezone: string;
}

export interface StoredSession {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
}

export interface StoredConnection {
  userId: string;
  /** MSAL account homeAccountId, used for silent token acquisition. */
  homeAccountId: string;
  scopes: string[];
  status: 'connected' | 'needs_reauth';
}

/**
 * Storage abstraction so the app is usable before Supabase exists.
 *
 * The memory implementation is a development convenience only — it is
 * announced loudly at boot and everything in it is lost on restart.
 */
export interface AuthStore {
  upsertUser(u: Omit<StoredUser, 'id'>): Promise<StoredUser>;
  getUserById(id: string): Promise<StoredUser | null>;

  createSession(s: StoredSession): Promise<void>;
  getSession(tokenHash: string): Promise<StoredSession | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;

  saveConnection(c: StoredConnection, refreshTokenPlain?: string): Promise<void>;
  getConnection(userId: string): Promise<StoredConnection | null>;
  listConnectedUsers(): Promise<Array<{ user: StoredUser; connection: StoredConnection }>>;
  markNeedsReauth(userId: string): Promise<void>;
}

// ---------------------------------------------------------------- memory ----

class MemoryAuthStore implements AuthStore {
  private users = new Map<string, StoredUser>();
  private byMsId = new Map<string, string>();
  private sessions = new Map<string, StoredSession>();
  private connections = new Map<string, StoredConnection>();

  async upsertUser(u: Omit<StoredUser, 'id'>): Promise<StoredUser> {
    const existingId = this.byMsId.get(u.msUserId);
    const id = existingId ?? `mem_${u.msUserId}`;
    const user: StoredUser = { id, ...u };
    this.users.set(id, user);
    this.byMsId.set(u.msUserId, id);
    return user;
  }

  async getUserById(id: string) {
    return this.users.get(id) ?? null;
  }

  async createSession(s: StoredSession) {
    this.sessions.set(s.tokenHash, s);
  }

  async getSession(tokenHash: string) {
    const s = this.sessions.get(tokenHash);
    if (!s) return null;
    if (s.expiresAt.getTime() < Date.now()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return s;
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async deleteSessionsForUser(userId: string) {
    for (const [hash, s] of this.sessions) if (s.userId === userId) this.sessions.delete(hash);
  }

  async saveConnection(c: StoredConnection) {
    this.connections.set(c.userId, c);
  }

  async getConnection(userId: string) {
    return this.connections.get(userId) ?? null;
  }

  async listConnectedUsers() {
    const result: Array<{ user: StoredUser; connection: StoredConnection }> = [];
    for (const connection of this.connections.values()) {
      const user = this.users.get(connection.userId);
      if (user && connection.status === 'connected') result.push({ user, connection: { ...connection } });
    }
    return result;
  }

  async markNeedsReauth(userId: string) {
    const c = this.connections.get(userId);
    if (c) c.status = 'needs_reauth';
  }
}

// ------------------------------------------------------------- postgres ----

class PostgresAuthStore implements AuthStore {
  async upsertUser(u: Omit<StoredUser, 'id'>): Promise<StoredUser> {
    const db = requireDb();
    const rows = await db<{ id: string }[]>`
      insert into users (ms_user_id, email, display_name, job_title, timezone)
      values (${u.msUserId}, ${u.email}, ${u.displayName}, ${u.jobTitle}, ${u.timezone})
      on conflict (ms_user_id) do update set
        email        = excluded.email,
        display_name = excluded.display_name,
        job_title    = excluded.job_title,
        timezone     = excluded.timezone,
        last_login_at = now(),
        updated_at   = now()
      returning id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('Failed to upsert user.');
    return { id, ...u };
  }

  async getUserById(id: string): Promise<StoredUser | null> {
    const db = requireDb();
    const rows = await db<
      { id: string; ms_user_id: string; email: string; display_name: string; job_title: string | null; timezone: string }[]
    >`select id, ms_user_id, email, display_name, job_title, timezone from users where id = ${id} and is_active limit 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      msUserId: r.ms_user_id,
      email: r.email,
      displayName: r.display_name,
      jobTitle: r.job_title,
      timezone: r.timezone,
    };
  }

  async createSession(s: StoredSession) {
    const db = requireDb();
    await db`insert into sessions (token_hash, user_id, expires_at) values (${s.tokenHash}, ${s.userId}, ${s.expiresAt})`;
  }

  async getSession(tokenHash: string): Promise<StoredSession | null> {
    const db = requireDb();
    const rows = await db<{ token_hash: string; user_id: string; expires_at: Date }[]>`
      select token_hash, user_id, expires_at from sessions
      where token_hash = ${tokenHash} and revoked_at is null and expires_at > now()
      limit 1
    `;
    const r = rows[0];
    return r ? { tokenHash: r.token_hash, userId: r.user_id, expiresAt: r.expires_at } : null;
  }

  async deleteSession(tokenHash: string) {
    const db = requireDb();
    await db`update sessions set revoked_at = now() where token_hash = ${tokenHash}`;
  }

  async deleteSessionsForUser(userId: string) {
    const db = requireDb();
    await db`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
  }

  async saveConnection(c: StoredConnection, refreshTokenPlain?: string) {
    const db = requireDb();
    const cipher = refreshTokenPlain ? encryptSecret(refreshTokenPlain) : null;
    await db`
      insert into oauth_connections (user_id, provider, home_account_id, scopes, refresh_token_encrypted, status)
      values (${c.userId}, 'microsoft', ${c.homeAccountId}, ${c.scopes}, ${cipher}, ${c.status})
      on conflict (user_id, provider) do update set
        home_account_id         = excluded.home_account_id,
        scopes                  = excluded.scopes,
        refresh_token_encrypted = coalesce(excluded.refresh_token_encrypted, oauth_connections.refresh_token_encrypted),
        status                  = excluded.status,
        last_refreshed_at       = now(),
        updated_at              = now()
    `;
  }

  async getConnection(userId: string): Promise<StoredConnection | null> {
    const db = requireDb();
    const rows = await db<{ home_account_id: string; scopes: string[]; status: string }[]>`
      select home_account_id, scopes, status from oauth_connections
      where user_id = ${userId} and provider = 'microsoft' limit 1
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      userId,
      homeAccountId: r.home_account_id,
      scopes: r.scopes,
      status: r.status === 'connected' ? 'connected' : 'needs_reauth',
    };
  }

  async listConnectedUsers(): Promise<Array<{ user: StoredUser; connection: StoredConnection }>> {
    const db = requireDb();
    const rows = await db<Array<{
      id: string; ms_user_id: string; email: string; display_name: string; job_title: string | null; timezone: string;
      home_account_id: string; scopes: string[];
    }>>`select u.id,u.ms_user_id,u.email,u.display_name,u.job_title,u.timezone,c.home_account_id,c.scopes
      from users u join oauth_connections c on c.user_id=u.id
      where u.is_active and c.provider='microsoft' and c.status='connected'`;
    return rows.map((row) => ({
      user: { id: row.id, msUserId: row.ms_user_id, email: row.email, displayName: row.display_name, jobTitle: row.job_title, timezone: row.timezone },
      connection: { userId: row.id, homeAccountId: row.home_account_id, scopes: row.scopes, status: 'connected' },
    }));
  }

  async markNeedsReauth(userId: string) {
    const db = requireDb();
    await db`update oauth_connections set status = 'needs_reauth', updated_at = now() where user_id = ${userId}`;
  }
}

let instance: AuthStore | null = null;

export function authStore(): AuthStore {
  if (!instance) {
    instance = hasDb() ? new PostgresAuthStore() : new MemoryAuthStore();
    logger.info({ backend: hasDb() ? 'postgres' : 'memory' }, 'Auth store ready');
  }
  return instance;
}

/** Exposed for tests. */
export { MemoryAuthStore, PostgresAuthStore, decryptSecret };
