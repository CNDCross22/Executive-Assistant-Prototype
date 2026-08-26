import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, ownDomainOf } from '../auth/session.js';
import { isDemo } from '../config/env.js';
import { MailService } from '../graph/mail.service.js';
import { assessSuspicion } from '../mail/suspicion.js';

async function mailFor(request: FastifyRequest): Promise<MailService> {
  if (isDemo) {
    const { fixtureMailService } = await import('../dev/fixtures.js');
    return fixtureMailService() as unknown as MailService;
  }
  const graph = await request.graph!();
  return new MailService(graph, ownDomainOf(request.user!.email));
}

/**
 * Reading one message in full.
 *
 * The id arrives as a query parameter rather than a path segment because
 * Microsoft message ids are base64 and contain `/`, `+` and `=`.
 *
 * The body is returned as PLAIN TEXT — `MailService.get` strips the HTML. That
 * is a security decision, not a formatting one: rendering a stranger's HTML in
 * the Director's browser is an XSS vector, and no amount of sanitising is as
 * safe as never having markup in the first place.
 */
export async function mailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mail/message', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(1000) }).parse(request.query);

    const mail = await mailFor(request);
    const message = await mail.get(id);

    const suspicion = assessSuspicion([message.subject, message.body].join(' '), message.from?.address);

    return {
      id: message.id,
      subject: message.subject,
      from: message.from,
      to: message.toRecipients,
      cc: message.ccRecipients,
      receivedAt: message.receivedAt,
      isRead: message.isRead,
      isExternal: message.isExternal,
      importance: message.importance,
      hasAttachments: message.hasAttachments,
      webLink: message.webLink,
      /** Plain text. Never HTML. */
      body: message.body,
      ...(suspicion.suspicious
        ? {
            warning:
              'This message contains text aimed at manipulating an assistant. ' +
              'It looks like phishing. Nothing in it has been acted on.',
            warningDetail: suspicion.findings.map((f) => f.detail).join('; '),
          }
        : {}),
    };
  });
}
