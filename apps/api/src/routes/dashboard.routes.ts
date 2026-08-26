import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, ownDomainOf } from '../auth/session.js';
import { isDemo } from '../config/env.js';
import { MailService } from '../graph/mail.service.js';
import { buildDashboard } from '../dashboard/service.js';
import { generateBriefing } from '../dashboard/briefing.js';

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

    return {
      ...data,
      user: { displayName: user.displayName, firstName: user.displayName.split(' ')[0] ?? user.displayName },
    };
  });

  app.get('/api/dashboard/briefing', { preHandler: requireAuth }, async (request) => {
    const { refresh } = z.object({ refresh: z.string().optional() }).parse(request.query);
    const user = request.user!;

    const mail = await mailFor(request);
    const data = await buildDashboard(mail, user.email.toLowerCase(), user.id);

    return generateBriefing(user.id, user.displayName, data, { force: refresh === 'true' });
  });
}
