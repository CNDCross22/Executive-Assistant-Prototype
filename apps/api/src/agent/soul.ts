/**
 * Loads soul.md — the human-editable character file at the project root.
 *
 * Read fresh whenever the file changes, so the Director (or you) can tune the
 * personality without touching code or restarting anything.
 *
 * The file defines VOICE only. What the assistant is permitted to do is enforced in
 * guards.ts and the tool registry — nothing written in soul.md can widen it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { personaBlock, PERSONA } from './persona.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOUL_PATH = path.resolve(here, '../../../../soul.md');

/** Everything above the first `---` on its own line is notes for the human. */
const PREAMBLE_SEPARATOR = /^---\s*$/m;

let cached: { text: string; mtimeMs: number } | null = null;

function readSoulFile(): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(SOUL_PATH);
  } catch {
    return null; // no soul.md; the built-in persona is used
  }

  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;

  try {
    const raw = fs.readFileSync(SOUL_PATH, 'utf8');
    const parts = raw.split(PREAMBLE_SEPARATOR);
    // Drop the editing notes; keep everything after the first separator.
    const body = (parts.length > 1 ? parts.slice(1).join('\n---\n') : raw).trim();

    if (body.length < 40) {
      logger.warn('soul.md is empty or too short; using the built-in character');
      return null;
    }

    cached = { text: body, mtimeMs: stat.mtimeMs };
    logger.info({ words: body.split(/\s+/).length }, 'Loaded soul.md');
    return body;
  } catch (err) {
    logger.error({ err }, 'Could not read soul.md; using the built-in character');
    return null;
  }
}

/**
 * The character block for the system prompt.
 * Falls back to the built-in persona when soul.md is absent or unreadable.
 */
export function soulBlock(): string {
  return readSoulFile() ?? personaBlock(PERSONA);
}

/** For diagnostics: where the character came from, and how costly it is. */
export function soulStatus(): { source: 'soul.md' | 'built-in'; words: number; approxTokens: number } {
  const text = readSoulFile();
  const body = text ?? personaBlock(PERSONA);
  return {
    source: text ? 'soul.md' : 'built-in',
    words: body.split(/\s+/).length,
    approxTokens: Math.round(body.length / 4),
  };
}
