import type { FastifyInstance } from 'fastify';
import { env, getSetupStatus } from '../config/env.js';
import { modelPolicySummary } from '../ai/policy.js';
import { pingDb } from '../db/index.js';
import { requireAuth, ownDomainOf } from '../auth/session.js';
import { UserService } from '../graph/user.service.js';
import { MailService } from '../graph/mail.service.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, at: new Date().toISOString() }));

  /** What is wired up, and what is not. The setup screen renders this verbatim. */
  app.get('/api/setup', async () => {
    const setup = getSetupStatus();
    const db = await pingDb();

    return {
      ...setup,
      ai: {
        provider: 'openai' as const,
        model: env.OPENAI_MODEL,
        roles: modelPolicySummary(),
        adaptiveResponseLimits: env.HERMES_RESPONSE_MODES,
      },
      checks: setup.checks.map((c) =>
        c.key === 'database' ? { ...c, ready: db.ok, detail: db.ok ? 'Connected' : c.detail } : c,
      ),
      ready: setup.checks.filter((c) => c.key !== 'database').every((c) => c.ready) && db.ok,
    };
  });

  /**
   * Proves the Microsoft connection really works, without exposing content.
   * Counts and timings only.
   */
  app.get('/api/diagnostics/graph', { preHandler: requireAuth }, async (request) => {
    const graph = await request.graph!();
    const user = request.user!;
    const started = Date.now();

    const userService = new UserService(graph);
    const mailService = new MailService(graph, ownDomainOf(user.email));

    const [profile, settings, recent, unread] = await Promise.all([
      userService.getProfile(),
      userService.getMailboxSettings().catch(() => null),
      mailService.list({ limit: 10 }),
      mailService.list({ limit: 50, unreadOnly: true }),
    ]);

    return {
      ok: true,
      durationMs: Date.now() - started,
      account: { displayName: profile.displayName, email: profile.email, jobTitle: profile.jobTitle },
      mailbox: settings,
      mail: {
        recentCount: recent.length,
        unreadCount: unread.length,
        newestSubject: recent[0]?.subject ?? null,
        newestReceivedAt: recent[0]?.receivedAt ?? null,
      },
    };
  });
}
