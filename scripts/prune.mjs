#!/usr/bin/env node
/**
 * Applies the retention windows defined in migration 0014.
 *
 * Safe to run repeatedly and safe to run concurrently — every statement is a
 * bounded delete on an indexed timestamp. Intended for a schedule (see
 * .github/workflows/maintenance.yml), but a person can run it any time:
 *
 *   npm run db:prune
 *   npm run db:prune -- --dry-run
 *   npm run db:prune -- --audit-days=30
 *
 * Conversation history is never pruned unless --conversation-days is passed
 * explicitly. There is no default for it and there should not be one.
 */
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env'), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Nothing was pruned.');
  process.exit(1);
}

function flag(name) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!match) return undefined;
  const value = Number(match.split('=')[1]);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--${name} must be a whole number of days.`);
    process.exit(1);
  }
  return value;
}

const dryRun = process.argv.includes('--dry-run');
const windows = {
  audit: flag('audit-days') ?? 90,
  usage: flag('usage-days') ?? 400,
  session: flag('session-days') ?? 30,
  proactive: flag('proactive-days') ?? 60,
  conversation: flag('conversation-days') ?? null,
};

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

try {
  if (dryRun) {
    // Count with exactly the predicates hermes_prune uses, so the preview and
    // the real run can never disagree about what is in scope.
    const preview = await sql`
      select 'audit_events' as table_name,
             count(*) filter (where created_at < now() - make_interval(days => ${windows.audit})) as rows_affected
        from audit_events
      union all
      select 'ai_usage',
             count(*) filter (where created_at < now() - make_interval(days => ${windows.usage}))
        from ai_usage
      union all
      select 'sessions',
             count(*) filter (where expires_at < now() - make_interval(days => ${windows.session})
                                 or (revoked_at is not null and revoked_at < now() - make_interval(days => ${windows.session})))
        from sessions
      union all
      select 'proactive_notifications',
             count(*) filter (where created_at < now() - make_interval(days => ${windows.proactive}))
        from proactive_notifications
      union all
      select 'proactive_events',
             count(*) filter (where created_at < now() - make_interval(days => ${windows.proactive}))
        from proactive_events
    `;

    console.log('Dry run. Nothing was deleted.\n');
    for (const row of preview) {
      console.log(`  ${row.table_name.padEnd(24)} ${String(row.rows_affected).padStart(9)} row(s) in scope`);
    }
    if (windows.conversation === null) {
      console.log('\n  conversation_messages    excluded (pass --conversation-days to include)');
    }
  } else {
    const results = await sql`
      select * from hermes_prune(
        ${windows.audit}, ${windows.usage}, ${windows.session},
        ${windows.proactive}, ${windows.conversation}
      )
    `;

    let total = 0;
    console.log('Retention applied.\n');
    for (const row of results) {
      total += Number(row.rows_deleted);
      console.log(`  ${row.table_name.padEnd(24)} ${String(row.rows_deleted).padStart(9)} row(s) deleted`);
    }
    console.log(`\n  ${'total'.padEnd(24)} ${String(total).padStart(9)} row(s)`);
  }
} catch (err) {
  console.error('\nPrune failed:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
