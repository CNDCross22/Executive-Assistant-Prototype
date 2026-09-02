import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, ownDomainOf } from '../auth/session.js';
import { isDemo } from '../config/env.js';
import { MailService } from '../graph/mail.service.js';
import { UserService } from '../graph/user.service.js';
import { CalendarService } from '../graph/calendar.service.js';
import { ContactsService } from '../graph/contacts.service.js';
import { TasksService } from '../graph/tasks.service.js';
import { TeamsService } from '../graph/teams.service.js';
import { FilesService } from '../graph/files.service.js';
import { runAgent } from '../agent/orchestrator.js';
import { RefTable } from '../agent/refs.js';
import { sanitiseReply } from '../agent/sanitise.js';
import { aiProvider } from '../ai/index.js';
import { spendSummary } from '../ai/cost.js';
import type { ContextTurn } from '../agent/context.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { createOperationContext } from '../observability/context.js';
import { recordTelemetry } from '../observability/telemetry.js';
import { modelPolicySummary } from '../ai/policy.js';
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
const directoryQuery = z.object({ q: z.string().trim().min(1).max(100) });

function notFound(): AppError {
  return new AppError(404, 'not_found', 'That conversation is not there.');
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/assistant/status', { preHandler: requireAuth }, async () => {
    const provider = aiProvider();
    const [health, spend] = await Promise.all([provider.health(), spendSummary()]);
    return { model: provider.model, provider: provider.id, roles: modelPolicySummary(), ...health, spend };
  });

  // A small, read-only people picker for @mentions in the chat composer.
  // Results are tenant-directory users filtered to the Director's own domain.
  app.get('/api/directory/search', { preHandler: requireAuth }, async (request, reply) => {
    const { q } = directoryQuery.parse(request.query);
    if (isDemo) return { people: [] };

    const user = request.user!;
    const graph = await request.graph!();
    const users = new UserService(graph);
    const people = await users.searchOrganisationDirectory(q, ownDomainOf(user.email), 8);
    reply.header('Cache-Control', 'private, max-age=30');
    return { people };
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

  // A chat turn can spend real money and hold a connection for minutes. It has
  // no business sharing an allowance with /api/health. Twelve a minute is far
  // above human conversational pace and far below a runaway client.
  app.post('/api/assistant/chat', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (request) => {
    const { message, conversationId } = chatSchema.parse(request.body);
    const user = request.user!;

    // Resolve the thread, or open a new one titled from her first line.
    let id = conversationId;
    if (!id || !(await ownsConversation(user.id, id))) {
      id = await createConversation(user.id, deriveTitle(message));
    }

    const operation = createOperationContext({
      requestId: String(request.id),
      userId: user.id,
      conversationId: id,
      source: 'assistant',
    });

    const prior = await getMessages(user.id, id);
    // The context assembler receives the bounded stored history and chooses
    // recent plus relevant turns. It does not blindly replay all 200 rows.
    const history: ContextTurn[] = prior.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      steps: m.steps,
      approval: m.approval,
    }));

    let mail: MailService;
    let users: UserService;
    let calendar: CalendarService;
    let contacts: ContactsService;
    let tasks: TasksService;
    let teams: TeamsService;
    let files: FilesService;

    if (isDemo) {
      const { fixtureMailService, fixtureTeamsService, fixtureFilesService } = await import('../dev/fixtures.js');
      mail = fixtureMailService() as MailService;
      users = {} as UserService;
      calendar = {} as CalendarService;
      contacts = {} as ContactsService;
      tasks = {} as TasksService;
      teams = fixtureTeamsService() as TeamsService;
      files = fixtureFilesService() as FilesService;
    } else {
      const graph = await request.graph!();
      mail = new MailService(graph, ownDomainOf(user.email));
      users = new UserService(graph);
      calendar = new CalendarService(graph);
      contacts = new ContactsService(graph);
      tasks = new TasksService(graph);
      teams = new TeamsService(graph);
      files = new FilesService(graph);
    }

    const refs = new RefTable();
    const ctx = {
      user,
      mail,
      users,
      calendar,
      contacts,
      tasks,
      teams,
      files,
      me: user.email.toLowerCase(),
      refs,
      conversationId: id,
      requestId: operation.requestId,
      workflowId: operation.workflowId,
      // Strictly larger than the orchestrator's own 150s turn budget, so the
      // turn aborts itself and reports honestly rather than being killed here.
      signal: AbortSignal.timeout(170_000),
    };

    const started = Date.now();
    await appendMessage({ conversationId: id, role: 'user', content: message });
    let result: Awaited<ReturnType<typeof runAgent>>;
    try {
      result = await runAgent({ ctx, history, message });
    } catch (err) {
      void recordTelemetry({
        category: 'request', action: 'assistant_turn', status: 'failed', userId: user.id,
        requestId: operation.requestId, conversationId: id, workflowId: operation.workflowId,
        durationMs: Date.now() - started, reasonCode: 'request_error',
      });

      // The question is already stored. Without this the thread keeps it
      // forever with nothing after it, and reloading shows the Director a
      // message she sent that was apparently ignored. Record the failure as a
      // turn so the history stays truthful about what happened.
      //
      // Storing this must never mask the original error, so it is best-effort.
      try {
        await appendMessage({
          conversationId: id,
          role: 'assistant',
          content: err instanceof AppError
            ? `${err.message}${err.detail ? ` ${err.detail}` : ''}`
            : 'I could not complete that request. Nothing was changed.',
          steps: [],
          model: 'failed',
          durationMs: Date.now() - started,
          wasBlocked: true,
        });
      } catch (storeError) {
        logger.error({ err: storeError, conversationId: id }, 'Could not record a failed turn');
      }

      throw err;
    }

    // Enforced, not requested: strip machinery or ids that slipped through.
    const reply = sanitiseReply(result.reply, { knownIds: refs.realIds() });

    await appendMessage({
      conversationId: id,
      role: 'assistant',
      content: reply,
      steps: result.steps,
      approval: result.approval,
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
    void recordTelemetry({
      category: 'request', action: 'assistant_turn', status: 'success', userId: user.id,
      requestId: operation.requestId, conversationId: id, workflowId: operation.workflowId,
      durationMs: Date.now() - started, iterations: result.iterations,
    });

    return {
      conversationId: id,
      reply,
      steps: result.steps,
      approval: result.approval,
      meta: { iterations: result.iterations, model: result.model, durationMs: result.durationMs },
    };
  });
}
