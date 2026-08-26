import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, loginUrl, type MeResponse, type ConversationSummary, type SetupResponse } from '../lib/api';
import Sidebar, { type View } from '../components/Sidebar';
import { useEscape, useAction } from '../lib/hooks';
import Dashboard from './Dashboard';
import Assistant from './Assistant';
import Memory from './Memory';

/**
 * The shell. Owns the sidebar, which view is showing, and which conversation
 * is open — so the dashboard and the chat can hand off to each other without
 * either owning the other.
 */
export default function Workspace({
  user,
  microsoft,
  demo,
}: {
  user: NonNullable<MeResponse['user']>;
  microsoft: MeResponse['microsoft'];
  demo: boolean;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('dashboard');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { run, error: actionError, dismissError } = useAction();

  useEscape(sidebarOpen, () => setSidebarOpen(false));

  const { data: conversationData } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.get<{ conversations: ConversationSummary[] }>('/api/conversations'),
  });

  const { data: setup } = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupResponse>('/api/setup'),
    refetchInterval: 60_000,
  });

  const conversations = conversationData?.conversations ?? [];

  async function signOut() {
    // Deliberately ignored: whether or not the server accepted the logout, the
    // right next step is to drop this page and start over.
    await api.post('/api/auth/logout').catch(() => {});
    window.location.reload();
  }

  function openConversation(id: string) {
    setActiveId(id);
    setView('assistant');
    setSidebarOpen(false);
  }

  function startNew() {
    setActiveId(null);
    setPendingQuestion(null);
    setView('assistant');
    setSidebarOpen(false);
  }

  /** Dashboard hands a question to the chat and switches to it. */
  function askFromDashboard(question?: string) {
    setActiveId(null);
    setPendingQuestion(question ?? null);
    setView('assistant');
  }

  /*
    This swallowed its error. She confirmed "Remove", the refetch put the
    conversation straight back, and nothing explained why — the worst version
    of a silent failure, because it looks like the app ignored her.
  */
  async function removeConversation(id: string) {
    await run(id, () => api.del(`/api/conversations/${id}`), () => {
      if (id === activeId) startNew();
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });
  }

  const sidebarProps = {
    view,
    onViewChange: (v: View) => {
      setView(v);
      setSidebarOpen(false);
    },
    conversations,
    activeId,
    user,
    demo,
    spend: setup?.spend,
    onSelect: openConversation,
    onNew: startNew,
    onDelete: removeConversation,
    onSignOut: signOut,
  };

  return (
    <div className="flex h-full overflow-x-hidden">
      <div className="hidden w-[320px] shrink-0 lg:block">
        <Sidebar {...sidebarProps} />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="sheet-left w-[min(88vw,340px)]">
            <Sidebar {...sidebarProps} onClose={() => setSidebarOpen(false)} />
          </div>
          <button
            className="scrim flex-1"
            style={{ background: 'rgb(0 0 0 / 0.45)', border: 'none' }}
            aria-label="Close menu"
            onClick={() => setSidebarOpen(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        {actionError && (
          <div
            className="flex shrink-0 items-center justify-between gap-3 px-4 py-2"
            style={{ background: 'var(--clay-bg)', borderBottom: '1px solid var(--clay)' }}
            role="alert"
          >
            <span className="text-[0.9rem]">{actionError}</span>
            <button className="text-action shrink-0" onClick={dismissError}>
              Dismiss
            </button>
          </div>
        )}

        {demo && (
          <div
            className="shrink-0 px-6 py-1 text-center"
            style={{ background: 'var(--clay-bg)', borderBottom: '1px solid var(--clay)' }}
            role="status"
          >
            <span className="label" style={{ color: 'var(--clay)' }}>
              <span className="sm:hidden">Demo data — not a real mailbox</span>
              <span className="hidden sm:inline">
                Demo data — a made-up mailbox, not a real Microsoft account
              </span>
            </span>
          </div>
        )}

        {!demo && microsoft?.status !== 'connected' && (
          <div
            className="flex shrink-0 flex-wrap items-center justify-center gap-3 px-4 py-2 text-center"
            style={{ background: 'var(--clay-bg)', borderBottom: '1px solid var(--clay)' }}
            role="alert"
          >
            <span className="label" style={{ color: 'var(--clay)' }}>
              Your Microsoft connection has lapsed — nothing can be read until you reconnect
            </span>
            <a
              href={loginUrl}
              className="btn no-underline"
              style={{ padding: '4px 12px', fontSize: '0.78rem' }}
            >
              Reconnect
            </a>
          </div>
        )}

        <header
          className="flex shrink-0 items-center justify-between gap-3 px-4 py-2 sm:px-5"
          style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface)' }}
        >
          <button
            className="label lg:hidden"
            style={{ background: 'none', border: 'none' }}
            onClick={() => setSidebarOpen(true)}
          >
            ☰ Menu
          </button>

          <span className="label hidden truncate md:inline">
            {view === 'dashboard'
              ? 'Dashboard'
              : view === 'memory'
                ? 'What I remember'
                : (conversations.find((c) => c.id === activeId)?.title ?? 'New conversation')}
          </span>

          <div className="flex min-w-0 items-center gap-4">
            {setup?.ai && <span className="label hidden sm:inline">{setup.ai.model}</span>}
            <span className="label flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background: demo
                    ? 'var(--brass)'
                    : microsoft?.status !== 'connected'
                      ? 'var(--clay)'
                      : 'var(--sage)',
                }}
              />
              <span className="hidden sm:inline">
                {demo
                  ? 'Fixture mailbox'
                  : microsoft?.status !== 'connected'
                    ? 'Reconnect needed'
                    : 'Outlook connected'}
              </span>
            </span>
          </div>
        </header>

        {/* key forces a remount so the entry animation replays on each switch */}
        {view === 'dashboard' ? (
          <div key="dashboard" className="view-enter flex min-h-0 flex-1 flex-col">
            <Dashboard user={user} onAsk={askFromDashboard} />
          </div>
        ) : view === 'memory' ? (
          <div key="memory" className="view-enter flex min-h-0 flex-1 flex-col">
            <Memory />
          </div>
        ) : (
          <div key="assistant" className="view-enter flex min-h-0 flex-1 flex-col">
          <Assistant
            user={user}
            demo={demo}
            activeId={activeId}
            onConversationStarted={(id) => {
              setActiveId(id);
              void queryClient.invalidateQueries({ queryKey: ['conversations'] });
            }}
            initialQuestion={pendingQuestion}
            onInitialQuestionConsumed={() => setPendingQuestion(null)}
          />
          </div>
        )}
      </div>
    </div>
  );
}
