#!/usr/bin/env node
/**
 * Fills SESSION_SECRET and ENCRYPTION_KEY in .env without touching anything else.
 * Refuses to overwrite values that are already set.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

if (!fs.existsSync(envPath)) {
  if (!fs.existsSync(examplePath)) {
    console.error('No .env or .env.example found.');
    process.exit(1);
  }
  fs.copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example');
}

const secret = () => crypto.randomBytes(48).toString('base64url');
let contents = fs.readFileSync(envPath, 'utf8');
const filled = [];
const skipped = [];

for (const key of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
  const pattern = new RegExp(`^${key}=(.*)$`, 'm');
  const match = contents.match(pattern);

  if (!match) {
    contents += `\n${key}=${secret()}\n`;
    filled.push(key);
  } else if (match[1].trim() === '') {
    contents = contents.replace(pattern, `${key}=${secret()}`);
    filled.push(key);
  } else {
    skipped.push(key);
  }
}

fs.writeFileSync(envPath, contents, 'utf8');

if (filled.length) console.log(`Generated: ${filled.join(', ')}`);
if (skipped.length) console.log(`Already set, left alone: ${skipped.join(', ')}`);
console.log('\nNext: fill in the Microsoft and Supabase values in .env');
