/**
 * A unique id that works outside a secure context.
 *
 * `crypto.randomUUID()` is only defined on https or localhost. The Director
 * opening this from her phone on the office network hits
 * `http://192.168.x.x:5173`, which is NOT a secure context — there the call is
 * undefined, and every send threw a TypeError straight into the error
 * boundary. `getRandomValues` has no such restriction, so it carries the real
 * work and `randomUUID` is used only when it genuinely exists.
 *
 * These ids never leave the browser; they are React list keys for turns that
 * have not been saved yet.
 */
export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;

  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
    const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort. Collisions do not matter for a list key within one session.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
