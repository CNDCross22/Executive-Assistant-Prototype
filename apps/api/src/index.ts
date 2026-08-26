import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

import { env, isProd, isDemo, getSetupStatus } from './config/env.js';
import { logger } from './lib/logger.js';
import { toAppError } from './lib/errors.js';
import { closeDb } from './db/index.js';
import { authRoutes } from './routes/auth.routes.js';
import { systemRoutes } from './routes/system.routes.js';
import { assistantRoutes } from './routes/assistant.routes.js';
import { memoryRoutes } from './routes/memory.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { mailRoutes } from './routes/mail.routes.js';

async function build() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: isProd,
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1_000_000,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API only; the web app sets its own
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: [env.APP_URL],
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

  // Registered BEFORE the routes on purpose. Fastify encapsulates plugins, so
  // a handler set after app.register() never reaches those routes — which is
  // how raw Zod and Postgres errors were reaching the browser.
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });

  app.setErrorHandler((error, request, reply) => {
    // Fastify's own guards (rate limit, body size, malformed JSON) already
    // carry a usable status; pass those through rather than remapping.
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

    if ((error as { code?: string }).code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply
        .status(400)
        .send({ error: { code: 'bad_request', message: 'That request was not valid JSON.' } });
    }

    // Everything else — including raw Postgres and Zod errors, which must never
    // reach the browser describing our schema — goes through the mapper.
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

  return app;
}

async function main() {
  const app = await build();

  const status = getSetupStatus();
  for (const check of status.checks) {
    logger[check.ready ? 'info' : 'warn'](`${check.ready ? 'OK  ' : 'TODO'} ${check.label}: ${check.detail}`);
  }
  if (!status.ready) {
    logger.warn('Setup is incomplete. The app will run and show a setup screen instead of faking data.');
  }

  // Demo mode needs a real user row so foreign keys hold.
  if (isDemo) {
    try {
      const { seedDemoUser } = await import('./dev/fixtures.js');
      await seedDemoUser();
      logger.info('Demo user seeded');
    } catch (err) {
      logger.warn({ err }, 'Could not seed the demo user; demo will run without persistence');
    }
  }

  await app.listen({ port: env.API_PORT, host: '127.0.0.1' });
  logger.info(`API listening on ${env.API_URL}`);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
