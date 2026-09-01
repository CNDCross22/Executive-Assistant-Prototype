import { useState } from 'react';
import type { ConversationSummary, MeResponse } from '../lib/api';
import { useTheme } from '../lib/theme';
import { useEscape } from '../lib/hooks';
import Icon, { type IconName } from './Icon';

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

export type View = 'dashboard' | 'briefing' | 'assistant' | 'memory';

interface Props {
  view: View;
  onViewChange: (v: View) => void;
  conversations: ConversationSummary[];
  activeId: string | null;
  user: NonNullable<MeResponse['user']>;
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
  onSelect,
  onNew,
  onDelete,
  onSignOut,
  onClose,
}: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const { theme, toggle } = useTheme();
  const groups = groupByRecency(conversations);
  const navigation: { view: View; label: string; icon: IconName }[] = [
    { view: 'dashboard', label: 'Today', icon: 'today' },
    { view: 'briefing', label: 'Briefing', icon: 'briefing' },
    { view: 'assistant', label: 'Assistant', icon: 'assistant' },
    { view: 'memory', label: 'Preferences', icon: 'preferences' },
  ];

  // A half-finished confirmation must not survive the next thing she does.
  useEscape(confirming !== null, () => setConfirming(null));

  return (
    <aside
      className="flex h-full w-full flex-col"
      style={{ background: 'var(--sunk)', borderRight: '1px solid var(--line)' }}
    >
      {onClose && (
        <div className="flex justify-end px-3 pb-2 pt-3 lg:hidden">
          <button className="icon-button lg:hidden" onClick={onClose} aria-label="Close navigation">
            <Icon name="close" />
          </button>
        </div>
      )}

      <nav className="mx-3 mt-3 flex flex-col gap-1" aria-label="Workspace">
        {navigation.map((item) => (
          <button
            key={item.view}
            aria-current={view === item.view ? 'page' : undefined}
            className="switch-btn flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[0.9rem]"
            style={{
              background: view === item.view ? 'var(--surface)' : 'transparent',
              boxShadow: view === item.view ? 'var(--shadow)' : 'none',
              color: view === item.view ? 'var(--ink)' : 'var(--muted)',
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              border: view === item.view ? '1px solid var(--line)' : '1px solid transparent',
            }}
            onClick={() => onViewChange(item.view)}
          >
            <Icon name={item.icon} />
            {item.label}
          </button>
        ))}
      </nav>

      {view === 'assistant' && (
        <div className="px-3 pb-2 pt-4">
          <button className="btn w-full" onClick={onNew}>
            New conversation
          </button>
        </div>
      )}

      {/* threads */}
      {view === 'assistant' ? <nav className="scroll mt-2 min-h-0 flex-1 px-3 pb-2" aria-label="Conversations">
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
      </nav> : <div className="flex-1" />}

      {/* footer */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
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
              <span className="flex items-center gap-1.5">
                <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
                {theme === 'light' ? 'Dark' : 'Light'}
              </span>
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
