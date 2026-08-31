import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, isProd, isDemo } from '../config/env.js';
import { newSessionToken, hashToken } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { authStore, type StoredUser } from './store.js';
import { getAccessToken } from './msal.js';
import { GraphClient } from '../graph/client.js';

export const SESSION_COOKIE = 'hermes_session';
const SESSION_DAYS = 14;

declare module 'fastify' {
  interface FastifyRequest {
    user?: StoredUser;
    graph?: () => Promise<GraphClient>;
  }
}

export async function issueSession(reply: FastifyReply, userId: string): Promise<void> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await authStore().createSession({ tokenHash: hashToken(token), userId, expiresAt });

  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
    expires: expiresAt,
    signed: true,
  });
}

export async function clearSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw) {
    const unsigned = request.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) {
      await authStore().deleteSession(hashToken(unsigned.value));
    }
  }
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    secure: isProd,
    sameSite: env.COOKIE_SAME_SITE,
  });
}

/** Resolve the signed-in user, or null. Never throws. */
export async function currentUser(request: FastifyRequest): Promise<StoredUser | null> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const session = await authStore().getSession(hashToken(unsigned.value));
  if (!session) return null;

  return authStore().getUserById(session.userId);
}

/**
 * preHandler for protected routes. Attaches `request.user` and a lazy
 * `request.graph()` factory so tokens are only fetched when actually needed.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (isDemo) {
    const { fixtureUser } = await import('../dev/fixtures.js');
    request.user = fixtureUser();
    request.graph = async () => {
      throw Errors.notConfigured('Microsoft 365 (demo mode uses fixture data)');
    };
    return;
  }

  const user = await currentUser(request);
  if (!user) throw Errors.unauthorized();

  request.user = user;
  request.graph = async () => {
    const connection = await authStore().getConnection(user.id);
    if (!connection || connection.status !== 'connected') throw Errors.needsReauth();
    const token = await getAccessToken(user.id, connection.homeAccountId);
    return new GraphClient(token, { userId: user.id, requestId: request.id });
  };
}

export function ownDomainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

export { env };
