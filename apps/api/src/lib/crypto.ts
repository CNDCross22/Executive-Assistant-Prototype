import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function key(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is not set; refusing to handle secrets.');
  }
  // Normalise any passphrase to exactly 32 bytes.
  return crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();
}

/** Encrypt a secret for storage. Returns iv.tag.ciphertext, base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split('.');
  if (!ivPart || !tagPart || !dataPart) throw new Error('Malformed encrypted payload.');
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Opaque session token; only its hash is ever stored. */
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time compare for state values and tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
