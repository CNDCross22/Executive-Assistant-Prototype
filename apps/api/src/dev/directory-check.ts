/**
 * Read-only organisation-directory lookup for connection diagnostics.
 *
 * Usage: npm run test:directory -- "Person Name"
 */
import { requireDb, closeDb } from '../db/index.js';
import { getAccessToken } from '../auth/msal.js';
import { GraphClient } from '../graph/client.js';
import { UserService } from '../graph/user.service.js';

type Row = { id: string; email: string; home_account_id: string };

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) throw new Error('Supply a person name or organisation email address.');

  const db = requireDb();
  const rows = await db<Row[]>`
    select u.id, u.email, o.home_account_id
    from users u join oauth_connections o on o.user_id = u.id
    where u.is_active and o.provider = 'microsoft' and o.status = 'connected'
    order by u.last_login_at desc limit 1
  `;
  const user = rows[0];
  if (!user) throw new Error('No connected Microsoft user was found.');

  const domain = user.email.split('@')[1]?.toLowerCase() ?? '';
  const token = await getAccessToken(user.id, user.home_account_id);
  const users = new UserService(new GraphClient(token, { userId: user.id, requestId: 'directory-check' }));
  const matches = await users.searchOrganisationDirectory(query, domain, 25);

  console.log(JSON.stringify({ domain, query, matches }, null, 2));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : 'Directory lookup failed.');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
