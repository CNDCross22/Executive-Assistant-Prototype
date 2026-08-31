/**
 * Read-only Microsoft Graph capability smoke test.
 * It performs no mutation and logs no mailbox content. Microsoft getSchedule
 * is a read-only POST because its query parameters are carried in the body.
 */
import { requireDb, closeDb } from '../db/index.js';
import { getAccessToken } from '../auth/msal.js';
import { GraphClient } from '../graph/client.js';
import { MailService } from '../graph/mail.service.js';
import { UserService } from '../graph/user.service.js';
import { CalendarService } from '../graph/calendar.service.js';
import { ContactsService } from '../graph/contacts.service.js';
import { TasksService } from '../graph/tasks.service.js';
import { TeamsService } from '../graph/teams.service.js';
import { FilesService } from '../graph/files.service.js';

type Row = { id: string; email: string; display_name: string; timezone: string; home_account_id: string };

async function check(name: string, operation: () => Promise<number | string>): Promise<boolean> {
  try {
    console.log(`PASS  ${name}: ${await operation()}`);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error';
    console.log(`FAIL  ${name}: ${code}`);
    return false;
  }
}

async function main(): Promise<void> {
  const db = requireDb();
  const rows = await db<Row[]>`
    select u.id, u.email, u.display_name, u.timezone, o.home_account_id
    from users u join oauth_connections o on o.user_id = u.id
    where u.is_active and o.provider = 'microsoft' and o.status = 'connected'
    order by u.last_login_at desc limit 1
  `;
  const user = rows[0];
  if (!user) throw new Error('No connected Microsoft user was found. Sign in once, then run this test again.');

  const token = await getAccessToken(user.id, user.home_account_id);
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { scp?: string };
  const granted = new Set((payload.scp ?? '').toLowerCase().split(/\s+/));
  const requiredScopes = [
    'mail.readwrite', 'mail.send', 'calendars.readwrite', 'contacts.readwrite', 'mailboxsettings.readwrite', 'tasks.readwrite',
    'files.read', 'sites.read.all', 'team.readbasic.all', 'channel.readbasic.all', 'channelmessage.read.all',
  ];
  const missingScopes = requiredScopes.filter((scope) => !granted.has(scope));
  if (missingScopes.length) {
    console.log(`FAIL  Granted delegated scopes: missing ${missingScopes.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS  Granted delegated scopes: core actions plus Teams, OneDrive and SharePoint reads');
  }
  const graph = new GraphClient(token, { userId: user.id, requestId: 'read-only-smoke' });
  const mail = new MailService(graph, user.email.split('@')[1]?.toLowerCase() ?? '');
  const users = new UserService(graph);
  const calendar = new CalendarService(graph);
  const contacts = new ContactsService(graph);
  const tasks = new TasksService(graph);
  const teams = new TeamsService(graph);
  const files = new FilesService(graph);
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  const results = await Promise.all([
    check('User.Read', async () => (await users.getProfile()).email ? 'profile readable' : 'profile returned'),
    check('MailboxSettings.Read', async () => (await users.getMailboxSettings()).timezone),
    check('Mail.Read', async () => `${(await mail.list({ limit: 1 })).length} sample item(s)`),
    check('Mail attachments', async () => {
      const sample = (await mail.list({ limit: 10 })).find((message) => message.hasAttachments);
      return sample ? `${(await mail.listAttachments(sample.id)).length} attachment metadata item(s)` : 'no sample message with attachments';
    }),
    check('Mail folders', async () => `${(await mail.listFolders()).length} folder(s)`),
    check('Calendars.Read', async () => `${(await calendar.list(start.toISOString(), end.toISOString(), user.timezone, 10)).length} event(s) in next 7 days`),
    check('Calendar subject search', async () => `${(await calendar.search('__HermesCalendarSearchProbe__', user.timezone, 1)).length} probe match(es)`),
    check('Calendar free/busy', async () => {
      const schedules = await calendar.getSchedule(
        [user.email],
        start.toISOString().replace(/Z$/, ''),
        end.toISOString().replace(/Z$/, ''),
        'UTC',
        30,
      );
      return schedules[0]?.availabilityView ? 'availability readable' : 'schedule returned without availability';
    }),
    check('Contacts.Read', async () => `${(await contacts.list('', 1)).length} sample contact(s)`),
    check('People.Read', async () => `${(await contacts.people('', 3)).length} relevant person(s)`),
    check('User.ReadBasic.All', async () => `${(await users.searchDirectory(user.display_name.split(' ')[0] ?? user.email, 3)).length} directory match(es)`),
    check('Tasks.Read', async () => {
      const lists = await tasks.lists();
      if (lists[0]) await tasks.list(lists[0].id, 1);
      return `${lists.length} task list(s)`;
    }),
    check('Team.ReadBasic.All', async () => `${(await teams.listJoinedTeams(3)).length} joined team(s)`),
    check('Channel.ReadBasic.All and ChannelMessage.Read.All', async () => {
      const joined = await teams.listJoinedTeams(3);
      if (!joined[0]) return 'no joined team available for channel sample';
      const channels = await teams.listChannels(joined[0].id, 3);
      if (!channels[0]) return 'team has no readable channel sample';
      return `${(await teams.listChannelMessages(joined[0].id, channels[0].id, 1)).length} channel message sample(s)`;
    }),
    check('Files.Read', async () => `${(await files.listOneDrive(undefined, 3)).length} OneDrive item(s)`),
    check('Sites.Read.All', async () => `${(await files.searchSites('HermesPermissionProbe', 1)).length} SharePoint search match(es)`),
  ]);
  if (results.some((ok) => !ok)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Microsoft Graph smoke test failed.');
  process.exitCode = 1;
}).finally(() => closeDb());
