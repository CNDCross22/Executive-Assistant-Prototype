import { env, isDemo, getSetupStatus } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeDb } from './db/index.js';
import { createProactiveScheduler } from './proactive/scheduler.js';
import { buildApp } from './app.js';

async function main() {
  const app = await buildApp();
  const proactiveScheduler = createProactiveScheduler();
  app.addHook('onClose', async () => proactiveScheduler.stop());

  const status = getSetupStatus();
  for (const check of status.checks) {
    logger[check.ready ? 'info' : 'warn'](`${check.ready ? 'OK  ' : 'TODO'} ${check.label}: ${check.detail}`);
  }
  if (!status.ready) {
    logger.warn('Setup is incomplete. The app will run and show a setup screen instead of faking data.');
  }

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
