/**
 * The Microsoft Graph webhook.
 *
 * This is the only unauthenticated mutating endpoint in the application, so it
 * is deliberately narrow:
 *
 *   - It accepts a validation handshake and echoes the token back as plain
 *     text. Graph allows ten seconds for this, so nothing slow may happen
 *     before the reply.
 *   - It verifies every notification against the stored clientState hash and
 *     silently drops anything that does not match. An attacker who guesses the
 *     URL achieves nothing.
 *   - It never trusts notification content. The body carries an id; the
 *     mailbox is then read with the user's own delegated token.
 *   - It acknowledges before doing the work. Graph retries on a non-2xx, and
 *     work done inside the request would risk a timeout and a retry storm.
 *
 * It returns 202 for a well-formed batch whether or not every notification in
 * it was accepted, because telling Microsoft to retry a notification we have
 * already rejected would just produce the same rejection.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { acceptNotifications, scheduleScan, type GraphChangeNotification } from '../realtime/notifications.js';
import { logger } from '../lib/logger.js';

const validationQuery = z.object({
  validationToken: z.string().min(1).max(2_000).optional(),
});

const notificationBody = z.object({
  value: z.array(z.object({
    subscriptionId: z.string().max(200).optional(),
    clientState: z.string().max(500).optional(),
    changeType: z.string().max(50).optional(),
    resource: z.string().max(1_000).optional(),
    resourceData: z.object({ id: z.string().max(1_000).optional() }).passthrough().optional(),
    subscriptionExpirationDateTime: z.string().max(60).optional(),
  }).passthrough()).max(200),
});

export async function graphRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/graph/notifications', {
    // Microsoft can deliver bursts. This ceiling is well above normal traffic
    // and still bounds an abusive caller who has guessed the URL.
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { validationToken } = validationQuery.parse(request.query);

    // The handshake. Answer immediately and do nothing else — Graph treats a
    // slow or altered response as a failed subscription.
    if (validationToken) {
      return reply.status(200).type('text/plain').send(validationToken);
    }

    const parsed = notificationBody.safeParse(request.body);
    if (!parsed.success) {
      // Malformed input is a client error, not something to retry forever.
      return reply.status(400).send({ error: { code: 'bad_request', message: 'Unrecognised notification payload.' } });
    }

    const batch = parsed.data.value as GraphChangeNotification[];
    const { accepted, rejected, unavailable } = await acceptNotifications(batch);

    for (const userId of accepted) scheduleScan(userId);

    if (rejected > 0) {
      logger.warn({ rejected, accepted: accepted.length }, 'Dropped unverified Graph notifications');
    }

    // Nothing could be verified because our own store was unreachable. This is
    // the one case where a retry genuinely helps, so ask for one explicitly
    // rather than letting a database error surface as an unhandled failure.
    if (unavailable && accepted.length === 0) {
      return reply.status(503).send({
        error: { code: 'verification_unavailable', message: 'Notification could not be verified. Please retry.' },
      });
    }

    return reply.status(202).send();
  });
}
