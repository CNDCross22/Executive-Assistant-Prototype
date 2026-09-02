#!/usr/bin/env node
/**
 * How long does a Director turn actually take, and how often does one die?
 *
 * This is the measurement that decides how urgent the turn-durability work is.
 * The orchestrator arms a 180s abort, the chat route arms 300s, and the OpenAI
 * client is configured at 180s with two retries — three ceilings that can each
 * outlive the one above them. Whether that is a live problem or a theoretical
 * one is answerable from telemetry already being written.
 *
 * Every turn records two audit_events rows: one 'assistant_turn' with status
 * 'success' or 'failed'. A turn killed by a platform timeout records NEITHER,
 * so an incomplete turn is counted by looking for a user message with no
 * assistant reply after it — the same orphan the durability work removes.
 *
 *   npm run db:turn-metrics
 *   npm run db:turn-metrics -- --days=30
 */
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env'), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. There is nothing to measure.');
  process.exit(1);
}

const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : 14;
if (!Number.isInteger(days) || days < 1) {
  console.error('--days must be a positive whole number.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const ms = (value) => (value === null || value === undefined ? '—' : `${Math.round(Number(value))}ms`);

try {
  const since = sql`now() - make_interval(days => ${days})`;

  const [duration] = await sql`
    select
      count(*)                                                              as turns,
      count(*) filter (where status = 'failed')                             as failed,
      percentile_disc(0.50) within group (order by duration_ms)             as p50,
      percentile_disc(0.95) within group (order by duration_ms)             as p95,
      percentile_disc(0.99) within group (order by duration_ms)             as p99,
      max(duration_ms)                                                      as slowest,
      count(*) filter (where duration_ms > 60000)                           as over_60s,
      count(*) filter (where duration_ms > 120000)                          as over_120s,
      count(*) filter (where duration_ms > 150000)                          as over_150s
    from audit_events
    where category = 'request' and action = 'assistant_turn'
      and created_at >= ${since}
  `;

  const byMode = await sql`
    select coalesce(detail->>'modelRole', 'unknown')                        as role,
           count(*)                                                         as turns,
           percentile_disc(0.95) within group (order by duration_ms)        as p95
      from audit_events
     where category = 'model' and action = 'call' and created_at >= ${since}
     group by 1
     order by turns desc
  `;

  // A turn the platform killed leaves the question stored with no answer.
  const [orphans] = await sql`
    with ordered as (
      select m.id, m.role, m.created_at, m.conversation_id,
             lead(m.role) over (partition by m.conversation_id order by m.created_at) as next_role
        from conversation_messages m
       where m.created_at >= ${since}
    )
    select count(*) as orphaned
      from ordered
     where role = 'user' and next_role is distinct from 'assistant'
  `;

  const [budget] = await sql`
    select count(*) as blocked
      from audit_events
     where category = 'model' and status = 'failed'
       and detail->>'reasonCode' in ('budget_exhausted', 'budget_check_failed')
       and created_at >= ${since}
  `;

  console.log(`\nTurn metrics — last ${days} day(s)\n${'─'.repeat(46)}`);
  console.log(`  turns recorded        ${duration.turns}`);
  console.log(`  recorded failures     ${duration.failed}`);
  console.log(`  orphaned questions    ${orphans.orphaned}   <- turns that never finished`);
  console.log(`  budget refusals       ${budget.blocked}`);
  console.log(`\n  p50                   ${ms(duration.p50)}`);
  console.log(`  p95                   ${ms(duration.p95)}`);
  console.log(`  p99                   ${ms(duration.p99)}`);
  console.log(`  slowest               ${ms(duration.slowest)}`);
  console.log(`\n  over 60s              ${duration.over_60s}`);
  console.log(`  over 120s             ${duration.over_120s}`);
  console.log(`  over 150s             ${duration.over_150s}   <- at risk of a platform kill`);

  if (byMode.length) {
    console.log(`\n  model call p95 by role`);
    for (const row of byMode) {
      console.log(`    ${String(row.role).padEnd(18)} ${String(row.turns).padStart(6)} calls   p95 ${ms(row.p95)}`);
    }
  }

  // Two independent signals. Reporting them together as one number hides
  // which problem the numbers are actually describing.
  const slow = Number(duration.over_150s);
  const orphaned = Number(orphans.orphaned);
  const total = Number(duration.turns);

  console.log(`\n${'─'.repeat(46)}`);
  console.log(
    slow === 0
      ? '  Timeouts:  no turn ran past 150s. The nested budget is\n             correct insurance, not an active problem.'
      : `  Timeouts:  ${slow} turn(s) ran past 150s and risk a platform\n             kill. Prioritise the turn budget work.`,
  );
  console.log(
    orphaned === 0
      ? '  Orphans:   every question has an answer stored beside it.'
      : `  Orphans:   ${orphaned}${total ? ` of ${total}` : ''} turn(s) left a question with no answer\n             stored. Each one is a message the Director sent\n             that the thread shows as ignored.`,
  );
  if (orphaned > 0) {
    console.log('\n  Note: a trailing question in a conversation still in progress\n  counts here too, so treat this as an upper bound.');
  }
  console.log();
} catch (err) {
  console.error('\nCould not read metrics:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
