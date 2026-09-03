import { useState, type ReactNode } from 'react';

/**
 * A dashboard card that never grows the page.
 *
 * The body is its own scroll region, so a busy inbox makes the card scroll
 * rather than pushing everything below it off-screen. Long lists are also
 * capped behind a "show more" toggle, so the common case is short enough not
 * to need scrolling at all.
 */
export default function Card({
  title,
  count,
  /** Hide items beyond this many behind a toggle. */
  collapseAfter,
  totalItems,
  children,
  footer,
}: {
  title: string;
  count?: number;
  collapseAfter?: number;
  totalItems?: number;
  /** Given `visibleCount`, Infinity when expanded or uncapped. */
  children: ReactNode | ((visibleCount: number) => ReactNode);
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  const capped = collapseAfter !== undefined && totalItems !== undefined;
  const hidden = capped ? Math.max(0, totalItems - collapseAfter) : 0;
  const visibleCount = !capped || expanded ? Infinity : collapseAfter;

  return (
    <section className="panel card-in flex min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-lg" style={{ boxShadow: 'var(--shadow)' }}>
      <div
        className="flex shrink-0 items-baseline justify-between px-3.5 py-2.5 sm:px-4"
        style={{ borderBottom: '1px solid var(--line-soft)' }}
      >
        <h2 className="label">{title}</h2>
        {count !== undefined && count > 0 && (
          <span className="label" style={{ color: 'var(--brass)', fontVariantNumeric: 'tabular-nums' }}>
            {count}
          </span>
        )}
      </div>

      <div className="scroll min-h-0 min-w-0 flex-1 px-3.5 py-3 sm:px-4">
        {typeof children === 'function' ? children(visibleCount) : children}
      </div>

      {(hidden > 0 || footer) && (
        <div className="shrink-0 px-3.5 py-2 sm:px-4" style={{ borderTop: '1px solid var(--line-soft)' }}>
          {hidden > 0 ? (
            <button
              className="label"
              style={{ background: 'none', border: 'none', color: 'var(--brass)' }}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? '↑ Show less' : `${hidden} more →`}
            </button>
          ) : (
            footer
          )}
        </div>
      )}
    </section>
  );
}
