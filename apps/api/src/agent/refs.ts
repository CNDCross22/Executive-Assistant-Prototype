/**
 * Short opaque handles for messages.
 *
 * Microsoft message ids are 150+ character base64 blobs. Handed one, a model
 * will eventually paste it at the user — which happened. The fix is not to ask
 * it nicely; it is to never show it the id at all.
 *
 * Tools emit "e1", "e2" and resolve them back here. The real id never enters
 * the conversation, so it cannot leak into an answer.
 */
export class RefTable {
  private toReal = new Map<string, string>();
  private toRef = new Map<string, string>();
  private next = 1;

  /** Get (or create) the short handle for a real id. */
  ref(realId: string): string {
    const existing = this.toRef.get(realId);
    if (existing) return existing;

    const handle = `e${this.next++}`;
    this.toRef.set(realId, handle);
    this.toReal.set(handle, realId);
    return handle;
  }

  /** Resolve a handle back to the real id. Accepts a real id unchanged. */
  resolve(handle: string): string | null {
    const trimmed = handle.trim();
    const real = this.toReal.get(trimmed) ?? this.toReal.get(trimmed.toLowerCase());
    if (real) return real;

    // A model occasionally echoes a real id it saw elsewhere; allow it rather
    // than failing, but never hand one out.
    if (trimmed.length > 40) return trimmed;
    return null;
  }

  /** Every real id currently known, for scrubbing output. */
  realIds(): string[] {
    return [...this.toReal.values()];
  }
}
