import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import { env, isProd } from './config/env.js';
import { logger } from './lib/logger.js';
import { Errors, toAppError } from './lib/errors.js';
import { authRoutes } from './routes/auth.routes.js';
import { systemRoutes } from './routes/system.routes.js';
import { assistantRoutes } from './routes/assistant.routes.js';
import { memoryRoutes } from './routes/memory.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { mailRoutes } from './routes/mail.routes.js';
import { proactiveRoutes } from './routes/proactive.routes.js';

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

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: () => !isProd,
  });

  // Cross-site HttpOnly cookies are needed when Pages and Supabase use
  // different sites. For every mutation, require the configured UI origin so
  // an unrelated website cannot submit an authenticated request.
  app.addHook('onRequest', async (request) => {
    if (!isProd || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
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

  await app.ready();
  return app;
}
