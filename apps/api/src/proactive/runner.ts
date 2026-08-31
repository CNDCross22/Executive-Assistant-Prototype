import type { StoredUser } from '../auth/store.js';
import { ownDomainOf } from '../auth/session.js';
import { buildDashboard } from '../dashboard/service.js';
import { CalendarService } from '../graph/calendar.service.js';
import type { GraphClient } from '../graph/client.js';
import { MailService } from '../graph/mail.service.js';
import { scanProactiveSnapshot } from './engine.js';

export async function runProactiveRead(user: StoredUser, graph: GraphClient, options: {
  requestId?: string;
  deliveryMode?: 'observe' | 'notify';
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const mail = new MailService(graph, ownDomainOf(user.email));
  const dashboard = await buildDashboard(mail, user.email.toLowerCase(), user.id);
  const degradedSources: string[] = [];
  const calendar = await new CalendarService(graph)
    .list(now.toISOString(), new Date(now.getTime() + 48 * 3_600_000).toISOString(), 'UTC', 50)
    .catch(() => { degradedSources.push('calendar'); return []; });
  return scanProactiveSnapshot({ user, dashboard, calendar, degradedSources, requestId: options.requestId, now, deliveryMode: options.deliveryMode });
}
