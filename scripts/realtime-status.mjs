#!/usr/bin/env node
/**
 * What real-time mail is actually doing right now.
 *
 * Read-only. Answers the questions that matter after a sign-in or an incident:
 * is there a live subscription, when does it expire, has Microsoft ever called
 * us, and has the delta cursor advanced.
 *
 *   npm run realtime:status
 */
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env'), quiet: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const ago = (value) => {
  if (!value) return 'never';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};
const until = (value) => {
  const hours = (new Date(value).getTime() - Date.now()) / 3_600_000;
  return hours < 0 ? 'EXPIRED' : `${hours.toFixed(1)}h left`;
};

try {
  const subs = await sql`
    select s.subscription_id, s.status, s.expires_at, s.last_notified_at,
           s.last_renewed_at, s.renewal_failures, s.notification_url, u.email
      from graph_subscriptions s join users u on u.id = s.user_id
     order by s.created_at desc`;

  console.log('\nGraph subscriptions');
  console.log('─'.repeat(60));
  if (subs.length === 0) {
    console.log('  none — sign in to create one, or run npm run realtime:maintain');
  }
  for (const row of subs) {
    console.log(`  ${row.email}  [${row.status}]`);
    console.log(`    id            ${row.subscription_id}`);
    console.log(`    expires       ${until(row.expires_at)}`);
    console.log(`    last notified ${ago(row.last_notified_at)}`);
    console.log(`    last renewed  ${ago(row.last_renewed_at)}   failures: ${row.renewal_failures}`);
    console.log(`    url           ${row.notification_url}`);
  }

  const cursors = await sql`
    select c.folder, c.last_synced_at, c.last_error, u.email,
           (c.delta_link is not null) as has_link
      from mail_delta_cursors c join users u on u.id = c.user_id`;

  console.log('\nDelta cursors');
  console.log('─'.repeat(60));
  if (cursors.length === 0) console.log('  none — set on the first reconciliation pass');
  for (const row of cursors) {
    console.log(`  ${row.email} / ${row.folder}: link ${row.has_link ? 'stored' : 'MISSING'}, synced ${ago(row.last_synced_at)}${row.last_error ? `\n    last error: ${row.last_error}` : ''}`);
  }

  const notices = await sql`
    select count(*) filter (where status = 'unread') as unread, count(*) as total
      from proactive_notifications`;
  console.log('\nProactive notices');
  console.log('─'.repeat(60));
  console.log(`  ${notices[0].total} total, ${notices[0].unread} unread\n`);
} catch (err) {
  console.error('Could not read real-time status:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
