import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, ownDomainOf } from '../auth/session.js';
import { env, isDemo } from '../config/env.js';
import { MailService } from '../graph/mail.service.js';
import { CalendarService } from '../graph/calendar.service.js';
import { buildDashboard } from '../dashboard/service.js';
import { generateBriefing } from '../dashboard/briefing.js';
import { proactiveInbox, queueProactiveScan, scanProactiveSnapshot } from '../proactive/engine.js';

async function mailFor(request: FastifyRequest): Promise<MailService> {
  if (isDemo) {
    const { fixtureMailService } = await import('../dev/fixtures.js');
    return fixtureMailService() as unknown as MailService;
  }
  const graph = await request.graph!();
  return new MailService(graph, ownDomainOf(request.user!.email));
}

/**
 * Two endpoints, deliberately separate.
 *
 * /api/dashboard is deterministic and fast — it must render even with no AI
 * credits, no model, or a slow one. /api/dashboard/briefing is the optional
 * written summary on top, and is allowed to fail without taking the page down.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard', { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    const mail = await mailFor(request);
    const data = await buildDashboard(mail, user.email.toLowerCase(), user.id);

    // Demo mode has no real memory rows; show what the card looks like populated.
    if (isDemo && data.pendingProposals.length === 0) {
      const { DEMO_PROPOSALS } = await import('../dev/fixtures.js');
      data.pendingProposals = DEMO_PROPOSALS;
    }

    // A dashboard refresh is also a bounded proactive scan. It only reads
    // Microsoft 365 and writes Hermes' own in-app event state. Failure here is
    // isolated so a notice can never make the core dashboard unavailable.
    let proactive: Awaited<ReturnType<typeof proactiveInbox>> | null = null;
    try {
      proactive = await proactiveInbox(user.id, user.timezone);
      const requestId = String(request.id);
      queueProactiveScan(user.id, async () => {
        const degradedSources: string[] = [];
        const calendar = isDemo ? [] : await (async () => {
          const now = new Date();
          const graph = await request.graph!();
          return new CalendarService(graph).list(now.toISOString(), new Date(now.getTime() + 48 * 3_600_000).toISOString(), 'UTC', 50)
            .catch(() => { degradedSources.push('calendar'); return []; });
        })();
        await scanProactiveSnapshot({
          user, dashboard: data, calendar, degradedSources, requestId,
          deliveryMode: env.HERMES_PROACTIVE_DELIVERY,
        });
      }, (err) => request.log.warn({ err }, 'Proactive dashboard scan unavailable'));
    } catch (err) {
      request.log.warn({ err }, 'Proactive dashboard scan unavailable');
    }

    return {
      ...data,
      proactive,
      user: { displayName: user.displayName, firstName: user.displayName.split(' ')[0] ?? user.displayName },
    };
  });

  app.get('/api/dashboard/briefing', { preHandler: requireAuth }, async (request) => {
    const { refresh } = z.object({ refresh: z.string().optional() }).parse(request.query);
    const user = request.user!;

    const mail = await mailFor(request);
    const data = await buildDashboard(mail, user.email.toLowerCase(), user.id);

    return generateBriefing(user.id, user.displayName, data, {
      force: refresh === 'true',
      requestId: String(request.id),
    });
  });
}
