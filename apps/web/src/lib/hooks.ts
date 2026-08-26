import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

/**
 * Runs one write at a time and never swallows the failure.
 *
 * Every mutation in this app used to be `api.post(...).catch(() => {})`: a
 * failed approve, dismiss or delete refetched, put the row back exactly where
 * it was, and said nothing. Silent failure is the one behaviour this product
 * cannot have — she has to be able to trust that what she sees happened.
 *
 * `pending` also blocks the second click, so a double tap cannot fire the
 * request twice.
 */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, onDone?: () => void) => {
      if (pending) return;
      setPending(key);
      setError(null);
      try {
        await fn();
        onDone?.();
      } catch (err) {
        const e = err as ApiError;
        setError(e?.message ?? 'That did not work. Nothing was changed.');
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  return { run, pending, error, dismissError: () => setError(null) };
}

/**
 * Re-renders on a timer so relative times stay honest.
 *
 * "Updated just now" is computed at render, so without this it keeps saying
 * "just now" long after it stopped being true. When freshness is the point,
 * a frozen timestamp is worse than none.
 */
export function useTick(ms: number): void {
  const [, force] = useState(0);

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/**
 * Escape closes the thing on top.
 *
 * Every overlay here — the reading pane, the mobile drawer, a delete
 * confirmation — could only be dismissed by finding and hitting its specific
 * button. Escape is what people already try first.
 */
export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, onEscape]);
}
