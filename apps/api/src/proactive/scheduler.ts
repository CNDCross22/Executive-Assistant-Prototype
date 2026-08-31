import { authStore } from '../auth/store.js';
import { getAccessToken } from '../auth/msal.js';
import { env } from '../config/env.js';
import { GraphClient } from '../graph/client.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { runProactiveRead } from './runner.js';
import { queueProactiveScan } from './engine.js';

export interface ProactiveScheduler { runNow(): Promise<void>; stop(): void }

export function createProactiveScheduler(): ProactiveScheduler {
  let running = false;
  let stopped = false;

  const runNow = async () => {
    if (running || stopped || !env.HERMES_PROACTIVE_BACKGROUND) return;
    running = true;
    try {
      const connected = await authStore().listConnectedUsers();
      // One Director is the product boundary. The cap prevents an accidental
      // data migration from turning this process into an unbounded worker.
      for (const { user, connection } of connected.slice(0, 10)) {
        queueProactiveScan(user.id, async () => {
          const token = await getAccessToken(user.id, connection.homeAccountId);
          const graph = new GraphClient(token, { userId: user.id, requestId: `proactive:${crypto.randomUUID()}` });
          await runProactiveRead(user, graph, { deliveryMode: env.HERMES_PROACTIVE_DELIVERY });
        }, (err) => {
          if (err instanceof AppError && err.code === 'needs_reauth') void authStore().markNeedsReauth(user.id);
          logger.warn({ err, userId: user.id }, 'Proactive read did not complete');
        });
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runNow(), env.HERMES_PROACTIVE_INTERVAL_MINUTES * 60_000);
  timer.unref();
  const initial = setTimeout(() => void runNow(), 15_000);
  initial.unref();

  return {
    runNow,
    stop() { stopped = true; clearTimeout(initial); clearInterval(timer); },
  };
}
