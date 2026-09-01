import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import type { FastifyRequest } from 'fastify';

import { env, isProd } from './config/env.js';
import { logger } from './lib/logger.js';
import { hashToken } from './lib/crypto.js';
import { Errors, toAppError } from './lib/errors.js';
import { SESSION_COOKIE } from './auth/session.js';
import { authRoutes } from './routes/auth.routes.js';
import { systemRoutes } from './routes/system.routes.js';
import { assistantRoutes } from './routes/assistant.routes.js';
import { memoryRoutes } from './routes/memory.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { mailRoutes } from './routes/mail.routes.js';
import { proactiveRoutes } from './routes/proactive.routes.js';
import { graphRoutes } from './routes/graph.routes.js';

/** The Graph webhook. Exempt from the mutation-origin guard; see the hook below. */
export const WEBHOOK_PATH = '/api/graph/notifications';

// Re-exported so the Deno entry point can use the unit-tested implementation
// from the bundle instead of keeping its own untestable copy.
export { routeUrl } from './edge/route-url.js';

/**
 * Rate-limit identity for a signed-in caller.
 *
 * Returns a hash of the session token rather than the token itself, so no
 * credential is held in the rate limiter's key store. Falls back to the IP for
 * anonymous requests, which is all that is available before sign-in.
 */
function sessionKey(request: FastifyRequest): string | null {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return `u:${hashToken(unsigned.value)}`;
}

/** Build the API without binding a port so the same routes can run on Node or Edge. */
export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: isProd,
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_000_000,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    // The API is deliberately hosted separately from the Pages UI. Exact CORS
    // and the mutation-origin guard below remain the security boundary.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  const appOrigin = new URL(env.APP_URL).origin;
  await app.register(cors, {
    origin: [appOrigin],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET ?? 'development-only-insecure-secret-change-me-now',
    parseOptions: { path: '/' },
  });

  // Global ceiling. Keyed by session where there is one, so a shared office IP
  // cannot have one person's activity throttle everybody else.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: () => !isProd,
    keyGenerator: (request) => sessionKey(request) ?? request.ip,
  });

  // Cross-site HttpOnly cookies are needed when Pages and Supabase use
  // different sites. For every mutation, require the configured UI origin so
  // an unrelated website cannot submit an authenticated request.
  //
  // The Graph webhook is the one exception: Microsoft posts to it from its own
  // infrastructure with no Origin header at all. It carries no session cookie,
  // performs no action on the caller's authority, and authenticates itself by
  // the clientState hash instead — so the origin check would only ever block
  // the legitimate caller here.
  app.addHook('onRequest', async (request) => {
    if (!isProd || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    if (request.url.split('?')[0] === WEBHOOK_PATH) return;
    if (request.headers.origin !== appOrigin) throw Errors.invalidOrigin();
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyStatus = (error as { statusCode?: number }).statusCode;

    if (fastifyStatus === 429) {
      return reply
        .status(429)
        .send({ error: { code: 'rate_limited', message: 'Too many requests. Slow down a moment.' } });
    }

    if (fastifyStatus === 413) {
      return reply
        .status(413)
        .send({ error: { code: 'too_large', message: 'That request was too large.' } });
    }

    if (['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY'].includes((error as { code?: string }).code ?? '')) {
      return reply
        .status(400)
        .send({ error: { code: 'bad_request', message: 'That request was not valid JSON.' } });
    }

    const mapped = toAppError(error);
    if (mapped.statusCode >= 500) {
      request.log.error({ err: error, code: mapped.code }, 'Unhandled error');
    } else {
      request.log.warn({ code: mapped.code, detail: mapped.detail }, mapped.message);
    }

    return reply
      .status(mapped.statusCode)
      .send({ error: { code: mapped.code, message: mapped.message, detail: mapped.detail } });
  });

  await app.register(authRoutes);
  await app.register(systemRoutes);
  await app.register(assistantRoutes);
  await app.register(memoryRoutes);
  await app.register(dashboardRoutes);
  await app.register(mailRoutes);
  await app.register(proactiveRoutes);
  await app.register(graphRoutes);

  await app.ready();
  return app;
}
