import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, ownDomainOf } from '../auth/session.js';
import { isDemo } from '../config/env.js';
import { MailService } from '../graph/mail.service.js';
import { UserService } from '../graph/user.service.js';
import { runAgent } from '../agent/orchestrator.js';
import { RefTable } from '../agent/refs.js';
import { sanitiseReply } from '../agent/sanitise.js';
import { aiProvider } from '../ai/index.js';
import { spendSummary } from '../ai/cost.js';
import type { ChatMessage } from '../ai/provider.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  listConversations,
  createConversation,
  getMessages,
  appendMessage,
  ownsConversation,
  renameConversation,
  archiveConversation,
  togglePin,
  deriveTitle,
} from '../conversations/store.js';

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.string().max(64).optional(),
});

const idParam = z.object({ id: z.string().min(1).max(64) });

/** How many prior turns to replay. Long context makes small models drift. */
const HISTORY_TURNS = 8;

function notFound(): AppError {
  return new AppError(404, 'not_found', 'That conversation is not there.');
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/assistant/status', { preHandler: requireAuth }, async () => {
    const provider = aiProvider();
    const [health, spend] = await Promise.all([provider.health(), spendSummary()]);
    return { model: provider.model, provider: provider.id, ...health, spend };
  });

  // ------------------------------------------------------------ history ---

  app.get('/api/conversations', { preHandler: requireAuth }, async (request) => ({
    conversations: await listConversations(request.user!.id),
  }));

  app.get('/api/conversations/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await ownsConversation(request.user!.id, id))) throw notFound();
    return { id, messages: await getMessages(request.user!.id, id) };
  });

  app.patch('/api/conversations/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ title: z.string().min(1).max(120).optional(), pinned: z.boolean().optional() })
      .parse(request.body);

    if (!(await ownsConversation(request.user!.id, id))) throw notFound();
    if (body.title !== undefined) await renameConversation(request.user!.id, id, body.title);
    if (body.pinned !== undefined) await togglePin(request.user!.id, id);
    return { ok: true };
  });

  app.delete('/api/conversations/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await ownsConversation(request.user!.id, id))) throw notFound();
    await archiveConversation(request.user!.id, id);
    return { ok: true };
  });

  // --------------------------------------------------------------- chat ---

  app.post('/api/assistant/chat', { preHandler: requireAuth }, async (request) => {
    const { message, conversationId } = chatSchema.parse(request.body);
    const user = request.user!;

    // Resolve the thread, or open a new one titled from her first line.
    let id = conversationId;
    if (!id || !(await ownsConversation(user.id, id))) {
      id = await createConversation(user.id, deriveTitle(message));
    }

    const prior = await getMessages(user.id, id);
    const history: ChatMessage[] = prior
      .slice(-HISTORY_TURNS * 2)
      .map((m) => ({ role: m.role, content: m.content }));

    let mail: MailService;
    let users: UserService;

    if (isDemo) {
      const { fixtureMailService } = await import('../dev/fixtures.js');
      mail = fixtureMailService() as MailService;
      users = {} as UserService;
    } else {
      const graph = await request.graph!();
      mail = new MailService(graph, ownDomainOf(user.email));
      users = new UserService(graph);
    }

    const refs = new RefTable();
    const ctx = {
      user,
      mail,
      users,
      me: user.email.toLowerCase(),
      refs,
      signal: AbortSignal.timeout(300_000),
    };

    const started = Date.now();
    await appendMessage({ conversationId: id, role: 'user', content: message });

    const result = await runAgent({ ctx, history, message });

    // Enforced, not requested: strip machinery or ids that slipped through.
    const reply = sanitiseReply(result.reply, { knownIds: refs.realIds() });

    await appendMessage({
      conversationId: id,
      role: 'assistant',
      content: reply,
      steps: result.steps,
      model: result.model,
      durationMs: result.durationMs,
    });

    logger.info(
      {
        userId: user.id,
        conversationId: id,
        iterations: result.iterations,
        tools: result.steps.map((s) => s.tool),
        durationMs: Date.now() - started,
        model: result.model,
      },
      'Assistant turn',
    );

    return {
      conversationId: id,
      reply,
      steps: result.steps,
      meta: { iterations: result.iterations, model: result.model, durationMs: result.durationMs },
    };
  });
}
