#!/usr/bin/env node
/**
 * Applies supabase/migrations/*.sql in order, once each.
 *
 * Forward-only. Every applied file is recorded in schema_migrations so
 * re-running is safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { config } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env'), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env, then run this again.');
  console.error('Supabase: Project Settings > Database > Connection string > URI');
  process.exit(1);
}

const dir = path.join(root, 'supabase', 'migrations');
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  : [];

if (files.length === 0) {
  console.log('No migrations found.');
  process.exit(0);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

try {
  await sql`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }

    const contents = fs.readFileSync(path.join(dir, file), 'utf8');
    process.stdout.write(`  apply ${file} … `);

    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`insert into schema_migrations (name) values (${file})`;
    });

    console.log('done');
    count++;
  }

  console.log(count === 0 ? '\nAlready up to date.' : `\nApplied ${count} migration(s).`);
} catch (err) {
  console.error('\nMigration failed:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
