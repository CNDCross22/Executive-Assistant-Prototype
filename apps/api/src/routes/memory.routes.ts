import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { isUuid, Errors } from '../lib/errors.js';
import { isDemo } from '../config/env.js';
import { listMemory, remember, updateMemory, forget } from '../memory/store.js';
import { pendingSignals, PROPOSAL_THRESHOLD } from '../memory/learning.js';

/**
 * Memory management.
 *
 * She must be able to see, edit and delete everything the assistant believes about
 * her. That is not a nice-to-have: memory she cannot inspect is memory she
 * cannot trust, and an assistant she cannot correct gets abandoned.
 */
export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/memory', { preHandler: requireAuth }, async (request) => {
    const entries = await listMemory(request.user!.id);
    const signals = await pendingSignals(request.user!.id);

    return {
      remembered: entries.filter((e) => e.status === 'active'),
      /** Waiting for her yes or no. These do NOT influence answers yet. */
      proposed: entries.filter((e) => e.status === 'proposed'),
      dismissed: entries.filter((e) => e.status === 'dismissed'),
      /** Patterns being watched but not yet worth raising. */
      watching: signals,
      proposalThreshold: PROPOSAL_THRESHOLD,
    };
  });

  app.post('/api/memory', { preHandler: requireAuth }, async (request) => {
    const body = z
      .object({
        type: z.enum(['preference', 'person', 'working_style', 'operational', 'historical', 'procedural']),
        title: z.string().min(2).max(200),
        content: z.string().min(2).max(2000),
        key: z.string().max(80).optional(),
        subject: z.string().max(200).optional(),
        importance: z.number().int().min(1).max(5).optional(),
      })
      .parse(request.body);

    const entry = await remember({
      userId: request.user!.id,
      ...body,
      source: 'explicit',
      confidence: 1,
      status: 'active',
    });

    return { entry };
  });

  /**
   * Demo proposals are fixtures with no database row. Answering one should
   * feel normal rather than erroring, so it is acknowledged and discarded.
   */
  const isFixture = (id: string) => isDemo && id.startsWith('demo-');

  /** Approve a proposed preference. This is the moment it becomes real. */
  app.post('/api/memory/:id/approve', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    if (isFixture(id)) return { ok: true, demo: true };
    if (!isUuid(id)) throw Errors.notFound('that memory');
    await updateMemory(request.user!.id, id, { status: 'active' });
    return { ok: true };
  });

  /** Reject a proposal. It stays visible so she can see what was suggested. */
  app.post('/api/memory/:id/dismiss', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    if (isFixture(id)) return { ok: true, demo: true };
    if (!isUuid(id)) throw Errors.notFound('that memory');
    await updateMemory(request.user!.id, id, { status: 'dismissed' });
    return { ok: true };
  });

  app.patch('/api/memory/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    if (!isUuid(id)) throw Errors.notFound('that memory');
    const body = z
      .object({
        title: z.string().min(2).max(200).optional(),
        content: z.string().min(2).max(2000).optional(),
        importance: z.number().int().min(1).max(5).optional(),
        pinned: z.boolean().optional(),
      })
      .parse(request.body);

    await updateMemory(request.user!.id, id, body);
    return { ok: true };
  });

  app.delete('/api/memory/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    if (!isUuid(id)) throw Errors.notFound('that memory');
    await forget(request.user!.id, id);
    return { ok: true };
  });
}
