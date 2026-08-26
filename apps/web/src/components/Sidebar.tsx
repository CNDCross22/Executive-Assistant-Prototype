import { useState } from 'react';
import type { ConversationSummary, MeResponse, Spend } from '../lib/api';
import { useTheme } from '../lib/theme';
import { useEscape } from '../lib/hooks';

/** Group threads the way a person thinks about them, not by raw timestamp. */
function groupByRecency(conversations: ConversationSummary[]) {
  const now = Date.now();
  const day = 86_400_000;

  const groups: { label: string; items: ConversationSummary[] }[] = [
    { label: 'Pinned', items: [] },
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'This week', items: [] },
    { label: 'Earlier', items: [] },
  ];

  for (const c of conversations) {
    const age = now - Date.parse(c.lastMessageAt);
    if (c.pinned) groups[0]!.items.push(c);
    else if (age < day) groups[1]!.items.push(c);
    else if (age < 2 * day) groups[2]!.items.push(c);
    else if (age < 7 * day) groups[3]!.items.push(c);
    else groups[4]!.items.push(c);
  }

  return groups.filter((g) => g.items.length > 0);
}

export type View = 'dashboard' | 'assistant' | 'memory';

interface Props {
  view: View;
  onViewChange: (v: View) => void;
  conversations: ConversationSummary[];
  activeId: string | null;
  user: NonNullable<MeResponse['user']>;
  demo: boolean;
  spend?: Spend;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
  onClose?: () => void;
}

export default function Sidebar({
  view,
  onViewChange,
  conversations,
  activeId,
  user,
  demo,
  spend,
  onSelect,
  onNew,
  onDelete,
  onSignOut,
  onClose,
}: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const { theme, toggle } = useTheme();
  const groups = groupByRecency(conversations);

  // A half-finished confirmation must not survive the next thing she does.
  useEscape(confirming !== null, () => setConfirming(null));

  return (
    <aside
      className="flex h-full w-full flex-col"
      style={{ background: 'var(--sunk)', borderRight: '1px solid var(--line)' }}
    >
      {/* brand */}
      <div className="flex items-center justify-between px-4 pb-2.5 pt-4">
        <div className="flex items-baseline gap-2">
          <span className="h-display text-[1.05rem]">Executive Assistant</span>
          {demo && (
            <span className="label" style={{ color: 'var(--clay)' }}>
              demo
            </span>
          )}
        </div>
        {onClose && (
          <button className="label lg:hidden" style={{ background: 'none', border: 'none' }} onClick={onClose}>
            Close
          </button>
        )}
      </div>

      {/*
        Segmented switcher, on a three-column grid.

        Content-sized tabs pushed apart with justify-between looked wrong: the
        gaps between labels grew to whatever was left over, while the outer two
        stayed hugging the border. Equal columns give an even rhythm regardless
        of how long the labels are.

        `min-w-0` is load-bearing — grid items default to min-width:auto, so
        without it a long label refuses to shrink and pushes its column wide.
      */}
      <div
        className="mx-2.5 mb-1 grid grid-cols-3 gap-0.5 rounded-md p-0.5"
        style={{ background: 'var(--ground)', border: '1px solid var(--line)' }}
        role="tablist"
      >
        {(['dashboard', 'assistant', 'memory'] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            /*
              Weight is held constant across states. Selection used to thicken
              it, which changed the label's width and made it truncate inside
              its own column — so only background and colour signal selection,
              and nothing reflows when you switch.
            */
            className="switch-btn min-w-0 truncate rounded px-1.5 py-1.5 text-center text-[0.78rem]"
            style={{
              background: view === v ? 'var(--surface)' : 'transparent',
              boxShadow: view === v ? 'var(--shadow)' : 'none',
              color: view === v ? 'var(--ink)' : 'var(--muted)',
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              border: 'none',
            }}
            onClick={() => onViewChange(v)}
          >
            {v === 'dashboard' ? 'Dashboard' : v === 'assistant' ? 'Assistant' : 'Memory'}
          </button>
        ))}
      </div>

      {view === 'assistant' && (
        <div className="px-3 py-2.5">
          <button className="btn w-full" onClick={onNew}>
            New conversation
          </button>
        </div>
      )}

      {/* threads */}
      <nav className="scroll min-h-0 flex-1 px-3 pb-2" aria-label="Conversations">
        {conversations.length === 0 ? (
          <p
            className="px-3 pb-2 pt-1 text-[0.84rem] leading-relaxed"
            style={{ color: 'var(--faint)' }}
          >
            {view === 'assistant'
              ? 'Ask something and it will be saved here.'
              : 'Conversations you start will be saved here.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="label px-3 pb-1.5">{group.label}</p>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((c) =>
                  confirming === c.id ? (
                    /*
                      The confirmation REPLACES the row rather than floating
                      over it. It used to be absolutely positioned with no
                      background above a title that reserved only 32px, so
                      "Sure? No" landed on top of the words and neither could
                      be read.
                    */
                    <li key={c.id}>
                      <div
                        className="flex items-center gap-1.5 rounded px-2.5 py-2"
                        style={{ background: 'var(--clay-bg)', border: '1px solid var(--clay)' }}
                      >
                        <span className="min-w-0 flex-1 truncate text-[0.82rem]" style={{ color: 'var(--ink)' }}>
                          Remove this?
                        </span>
                        <button
                          className="shrink-0 rounded px-2 py-1 text-[0.78rem]"
                          style={{
                            background: 'var(--clay)',
                            color: 'var(--surface)',
                            border: 'none',
                            fontFamily: 'var(--font-display)',
                            fontWeight: 600,
                          }}
                          onClick={() => {
                            onDelete(c.id);
                            setConfirming(null);
                          }}
                        >
                          Remove
                        </button>
                        <button
                          className="shrink-0 rounded px-2 py-1 text-[0.78rem]"
                          style={{
                            background: 'transparent',
                            border: '1px solid var(--line)',
                            fontFamily: 'var(--font-display)',
                            fontWeight: 600,
                          }}
                          onClick={() => setConfirming(null)}
                        >
                          Keep
                        </button>
                      </div>
                    </li>
                  ) : (
                    <li key={c.id} className="group relative">
                      <button
                        className="thread pr-9"
                        aria-current={c.id === activeId}
                        onClick={() => onSelect(c.id)}
                        title={c.title}
                      >
                        {c.title}
                      </button>

                      {/*
                        `row-action` keeps this hidden until hover ONLY on
                        devices that have a pointer. It was `opacity-0
                        group-hover:opacity-100`, which on a phone meant there
                        was no way to delete a conversation at all.
                      */}
                      <button
                        className="row-action absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded text-[1rem] leading-none"
                        style={{ background: 'none', border: 'none', color: 'var(--muted)' }}
                        aria-label={`Remove ${c.title}`}
                        onClick={() => setConfirming(c.id)}
                      >
                        ×
                      </button>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))
        )}
      </nav>

      {/* footer */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        {spend && (
          <div className="mb-3">
            <div className="label mb-1 flex justify-between">
              <span>AI spend</span>
              <span style={{ color: spend.overBudget ? 'var(--clay)' : 'var(--muted)' }}>
                {spend.monthToDate} / {spend.budget}
              </span>
            </div>
            <div className="h-[3px] w-full overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, spend.percentUsed)}%`,
                  background: spend.overBudget ? 'var(--clay)' : 'var(--brass)',
                }}
              />
            </div>
          </div>
        )}

        <p
          className="truncate"
          style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '0.88rem' }}
        >
          {user.displayName}
        </p>
        <p className="label mt-0.5 break-all" style={{ lineHeight: 1.5 }}>
          {user.email}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex shrink-0 items-center gap-3">
            <button
              className="label rounded px-1.5 py-1"
              style={{ background: 'none', border: 'none' }}
              onClick={toggle}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            >
              {theme === 'light' ? '◐ Dark' : '◑ Light'}
            </button>
            <button
              className="label rounded px-1.5 py-1"
              style={{ background: 'none', border: 'none' }}
              onClick={onSignOut}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
