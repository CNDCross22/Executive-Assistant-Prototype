import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { env, isDemo } from '../config/env.js';
import { buildDashboard } from '../dashboard/service.js';
import { Errors } from '../lib/errors.js';
import { proactiveInbox, scanProactiveSnapshot } from '../proactive/engine.js';
import { runProactiveRead } from '../proactive/runner.js';
import { proactiveStore } from '../proactive/store.js';
import { PROACTIVE_EVENT_TYPES } from '../proactive/types.js';

const eventType = z.enum(PROACTIVE_EVENT_TYPES);
const clock = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const policyChanges = z.object({
  enabled: z.boolean().optional(), outcome: z.enum(['notify', 'recommend']).optional(),
  minimumSeverity: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  quietStart: clock.nullable().optional(), quietEnd: clock.nullable().optional(),
  cooldownMinutes: z.number().int().min(5).max(43_200).optional(), dailyCap: z.number().int().min(1).max(50).optional(),
}).refine((value) => Object.keys(value).length > 0, 'Supply at least one policy change.');

async function scanForRequest(request: Parameters<typeof requireAuth>[0]) {
  const user = request.user!;
  if (isDemo) {
    const { fixtureMailService } = await import('../dev/fixtures.js');
    const dashboard = await buildDashboard(fixtureMailService() as never, user.email.toLowerCase(), user.id);
    return scanProactiveSnapshot({ user, dashboard, calendar: [], requestId: String(request.id), deliveryMode: env.HERMES_PROACTIVE_DELIVERY });
  }
  const graph = await request.graph!();
  return runProactiveRead(user, graph, { requestId: String(request.id), deliveryMode: env.HERMES_PROACTIVE_DELIVERY });
}

export async function proactiveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/proactive', { preHandler: requireAuth }, async (request) => {
    const query = z.object({ scan: z.enum(['true', 'false']).optional() }).parse(request.query);
    if (query.scan === 'true') await scanForRequest(request);
    return proactiveInbox(request.user!.id, request.user!.timezone);
  });

  app.post('/api/proactive/scan', { preHandler: requireAuth }, async (request) => {
    const scan = await scanForRequest(request);
    return { scan, ...(await proactiveInbox(request.user!.id, request.user!.timezone)) };
  });

  app.patch('/api/proactive/policies/:eventType', { preHandler: requireAuth }, async (request) => {
    const params = z.object({ eventType }).parse(request.params);
    const changes = policyChanges.parse(request.body);
    const policy = await proactiveStore().updatePolicy(request.user!.id, params.eventType, changes);
    return { policy };
  });

  app.post('/api/proactive/notifications/:id/read', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!await proactiveStore().setNotificationStatus(request.user!.id, id, 'read', new Date())) throw Errors.notFound('that notice');
    return { ok: true };
  });

  app.post('/api/proactive/notifications/:id/dismiss', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!await proactiveStore().setNotificationStatus(request.user!.id, id, 'dismissed', new Date())) throw Errors.notFound('that notice');
    return { ok: true };
  });

  app.post('/api/proactive/notifications/:id/snooze', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { until } = z.object({ until: z.string().datetime() }).parse(request.body);
    const date = new Date(until);
    const now = new Date();
    if (date <= now || date.getTime() > now.getTime() + 30 * 86_400_000) throw Errors.badRequest('Choose a snooze time within the next 30 days.');
    if (!await proactiveStore().snooze(request.user!.id, id, date, now)) throw Errors.notFound('that notice');
    return { ok: true };
  });
}
