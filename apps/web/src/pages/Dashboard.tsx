import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MeResponse } from '../lib/api';
import Card from '../components/Card';
import MessageViewer from '../components/MessageViewer';
import { useAction, useTick } from '../lib/hooks';

interface DashboardItem {
  ref: string;
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  unread: boolean;
  external: boolean;
  importance: 'low' | 'normal' | 'high';
  reasons: string[];
  preview: string;
  warning?: string;
  webLink: string;
}

interface FollowUpItem {
  person: string;
  subject: string;
  daysWaiting: number;
  webLink: string;
}

interface DashboardResponse {
  generatedAt: string;
  needsYou: DashboardItem[];
  owedByYou: FollowUpItem[];
  waitingOnThem: FollowUpItem[];
  inbox: { unreadCount: number; receivedToday: number; filteredOut: number; considered: number };
  pendingProposals: { id: string; title: string; content: string }[];
  user: { displayName: string; firstName: string };
}

interface BriefingResponse {
  available: boolean;
  text: string;
  unavailableReason?: string;
  cached: boolean;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/*
  Resolution below an hour is not optional here.

  This used to return "just now" for anything under 60 minutes, so a dashboard
  last refreshed 55 minutes ago still claimed to be current. When the whole
  promise is that the mailbox is live, that reads as a lie.
*/
function ago(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function FollowUpList({ items, visible, empty }: { items: FollowUpItem[]; visible: number; empty: string }) {
  if (items.length === 0) return <p style={{ color: 'var(--muted)' }}>{empty}</p>;

  return (
    <ul className="flex min-w-0 flex-col gap-0.5">
      {items.slice(0, visible).map((f) => (
        /*
          `webLink` was fetched for every follow-up and then never used, so
          these rows looked like the ones above but could not be opened. They
          go to Outlook now, like everything else that names a message.
        */
        <li key={`${f.person}-${f.subject}-${f.daysWaiting}`} className="min-w-0">
          <a
            href={f.webLink}
            target="_blank"
            rel="noreferrer"
            className="lift -mx-1.5 block min-w-0 rounded px-1.5 py-1.5 no-underline"
            style={{ color: 'inherit' }}
            title={`${f.subject} — open in Outlook`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[0.95rem]">{f.person}</span>
              <span
                className="label shrink-0"
                style={{ color: f.daysWaiting >= 7 ? 'var(--clay)' : 'var(--muted)' }}
              >
                {f.daysWaiting}d
              </span>
            </span>
            <span className="block truncate text-[0.85rem]" style={{ color: 'var(--muted)' }}>
              {f.subject}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard({
  user,
  onAsk,
}: {
  user: NonNullable<MeResponse['user']>;
  onAsk: (question?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [briefingOpen, setBriefingOpen] = useState(true);
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const { run, pending, error: actionError, dismissError } = useAction();

  // Keeps "updated 20s ago" counting rather than frozen at render time.
  useTick(10_000);

  /*
    45 seconds, not 5 minutes.

    This is deterministic server work — Graph reads plus scoring — with no
    model involved, so refreshing often costs nothing but a little quota.
    TanStack pauses the interval while the tab is hidden by default, so a
    dashboard left open overnight is not polling all night.
  */
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardResponse>('/api/dashboard'),
    refetchInterval: 45_000,
  });

  /*
    The briefing is the one thing here that costs money, so it deliberately
    does NOT chase focus or the poll. The server already caches it against a
    fingerprint of the mailbox, so this call is free until the mail actually
    changes — but tying it to every refetch would still hand the budget to
    whoever emails her most.
  */
  const { data: briefing, isFetching: briefingLoading } = useQuery({
    queryKey: ['briefing'],
    queryFn: () => api.get<BriefingResponse>('/api/dashboard/briefing'),
    enabled: Boolean(data),
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const firstName = data?.user.firstName ?? user.displayName.split(' ')[0] ?? user.displayName;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label">Reading your inbox…</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20 text-center">
        <p className="label mb-3">Could not load</p>
        <p className="mb-6" style={{ color: 'var(--ink-soft)' }}>
          I could not reach your mailbox just now.
        </p>
        <button className="btn" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const { needsYou, owedByYou, waitingOnThem, inbox, pendingProposals } = data;

  const stats = [
    { label: 'Needs you', value: needsYou.length, accent: needsYou.length > 0 },
    { label: 'You owe', value: owedByYou.length, accent: owedByYou.length > 0 },
    { label: 'Unread', value: inbox.unreadCount, accent: false },
    { label: 'Filtered', value: inbox.filteredOut, accent: false },
  ];

  return (
    <>
      {openMessageId && (
        <MessageViewer
          messageId={openMessageId}
          onClose={() => setOpenMessageId(null)}
          onAsk={(q) => onAsk(q)}
        />
      )}

      {/*
        Below `lg` the page scrolls normally — stacking is right on a phone.
        At `lg` and above nothing scrolls: the grid fills the viewport and each
        card scrolls inside itself.
      */}
      <div className="scroll h-full overflow-x-hidden lg:flex lg:flex-col lg:overflow-hidden">
      <div className="mx-auto flex w-full max-w-[80rem] flex-col gap-3 px-4 py-4 sm:px-5 lg:min-h-0 lg:flex-1">
        {/* ---- greeting + briefing (fixed) ---- */}
        <header className="shrink-0">
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h1 className="h-display text-[1.45rem] leading-tight sm:text-[1.75rem]">
              {greeting()}, {firstName}
            </h1>
            {/*
              Freshness is stated, live, and can be forced. She has to be able
              to tell at a glance whether she is looking at her mailbox or at a
              memory of it.
            */}
            <p className="label flex items-center gap-2">
              <span className="hidden sm:inline">
                {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
                {' · '}
              </span>
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: isFetching ? 'var(--brass)' : 'var(--sage)',
                  animation: isFetching ? 'pulse-dot 1.1s ease-in-out infinite' : 'none',
                }}
              />
              <span>{isFetching ? 'checking now' : `updated ${ago(data.generatedAt)}`}</span>
              <button
                className="text-action"
                disabled={isFetching}
                onClick={() => void refetch()}
                title="Check the mailbox again now"
              >
                Refresh
              </button>
            </p>
          </div>

          <div
            className="rounded-lg px-4 py-3"
            style={{ background: 'var(--brass-soft)', border: '1px solid var(--line)' }}
          >
            <div className="flex items-baseline justify-between gap-4">
              <span className="label" style={{ color: 'var(--brass)' }}>
                Your briefing
              </span>
              <div className="flex shrink-0 gap-3">
                {briefing?.available && (
                  <button
                    className="text-action"
                    disabled={pending !== null}
                    onClick={() =>
                      void run('briefing', () => api.get('/api/dashboard/briefing?refresh=true'), () =>
                        queryClient.invalidateQueries({ queryKey: ['briefing'] }),
                      )
                    }
                  >
                    {pending === 'briefing' ? 'Rewriting…' : 'Refresh'}
                  </button>
                )}
                <button
                  className="text-action"
                  aria-expanded={briefingOpen}
                  onClick={() => setBriefingOpen((o) => !o)}
                >
                  {briefingOpen ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {briefingOpen && (
              <div className="mt-1.5">
                {/*
                  Was `briefingLoading && !briefing` — on a refresh the old
                  briefing still existed, so the indicator never appeared and
                  the button looked broken until the text silently changed.
                */}
                {briefingLoading || pending === 'briefing' ? (
                  <p className="label flex items-center gap-1.5">
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                    <span className="thinking-dot" />
                    <span className="ml-1.5">Writing your summary</span>
                  </p>
                ) : briefing?.available ? (
                  <p className="reply">{briefing.text}</p>
                ) : (
                  <p style={{ color: 'var(--muted)' }}>
                    {briefing?.unavailableReason ?? 'No written summary available.'}
                  </p>
                )}
              </div>
            )}
          </div>
        </header>

        {/* A failed approve/dismiss/refresh used to vanish without a word. */}
        {actionError && (
          <div
            className="flex shrink-0 items-start justify-between gap-3 rounded-lg px-4 py-2.5"
            style={{ background: 'var(--clay-bg)', border: '1px solid var(--clay)' }}
            role="alert"
          >
            <p className="text-[0.92rem]">{actionError}</p>
            <button className="text-action shrink-0" onClick={dismissError}>
              Dismiss
            </button>
          </div>
        )}

        {/* ---- stats (fixed) ---- */}
        <div className="grid shrink-0 grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
          {stats.map((stat, i) => (
            <div
              key={stat.label}
              className="panel card-in flex items-baseline gap-2.5 rounded-lg px-4 py-3"
              style={{
                animationDelay: `${i * 45}ms`,
                // A brass edge marks the counts that actually demand something of her.
                borderLeft: stat.accent ? '2px solid var(--brass)' : '1px solid var(--line)',
              }}
            >
              <span
                className="h-display text-[1.75rem] leading-none"
                style={{
                  color: stat.accent ? 'var(--brass)' : 'var(--ink)',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: 700,
                }}
              >
                {stat.value}
              </span>
              <span className="label leading-tight">{stat.label}</span>
            </div>
          ))}
        </div>

        {/* ---- cards: fill remaining height, scroll internally ---- */}
        <div className="grid min-w-0 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,20rem)]">
          <Card title="Needs you" count={needsYou.length} collapseAfter={7} totalItems={needsYou.length}>
            {(visible) =>
              needsYou.length === 0 ? (
                <p style={{ color: 'var(--muted)' }}>
                  Nothing pressing. {inbox.considered} messages came in and none need you.
                </p>
              ) : (
                <ul className="flex min-w-0 flex-col">
                  {needsYou.slice(0, visible).map((item, idx) => (
                    <li
                      key={item.ref}
                      style={{ borderTop: idx === 0 ? 'none' : '1px solid var(--line-soft)' }}
                    >
                      <button
                        className="lift block w-full min-w-0 cursor-pointer rounded px-2 py-3 text-left"
                        style={{ background: 'none', border: 'none' }}
                        onClick={() => setOpenMessageId(item.id)}
                      >
                      {/*
                        Everything inside this button is a <span>. A <button>
                        may only contain phrasing content — <p> and <div> made
                        the markup invalid and left screen readers announcing
                        the row as a jumble.
                      */}
                      {item.warning && (
                        <span
                          className="mb-2 block rounded border-l-2 px-3 py-1.5 text-[0.85rem]"
                          style={{ background: 'var(--clay-bg)', borderColor: 'var(--clay)' }}
                        >
                          {item.warning}
                        </span>
                      )}

                      {/*
                        Hierarchy: who it is, then what it is, then the gist.
                        Unread is carried by weight and a dot rather than a chip,
                        so the eye finds it without reading anything.
                      */}
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-baseline gap-2">
                          {item.unread && (
                            <span
                              aria-label="unread"
                              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ background: 'var(--brass)' }}
                            />
                          )}
                          <span
                            className="truncate"
                            style={{
                              fontFamily: 'var(--font-display)',
                              fontWeight: item.unread ? 700 : 500,
                              fontSize: '1.02rem',
                              letterSpacing: '-0.01em',
                            }}
                          >
                            {item.from}
                          </span>
                          {item.importance === 'high' && (
                            <span className="label shrink-0" style={{ color: 'var(--clay)' }}>
                              urgent
                            </span>
                          )}
                        </span>
                        <span className="label shrink-0">{ago(item.receivedAt)}</span>
                      </span>

                      <span className="mt-0.5 block truncate" style={{ color: 'var(--ink)', fontSize: '0.97rem' }}>
                        {item.subject}
                      </span>
                      <span className="mt-0.5 block truncate text-[0.87rem]" style={{ color: 'var(--muted)' }}>
                        {item.preview}
                      </span>

                      {/*
                        The reasons are supporting evidence, not labels to read
                        one by one — set as a quiet single line so the row scans
                        in one movement, with the action pinned right.
                      */}
                      <span className="mt-2 flex min-w-0 items-baseline gap-3">
                        <span className="label truncate">{item.reasons.slice(0, 2).join(' · ')}</span>
                        <span className="label ml-auto shrink-0" style={{ color: 'var(--brass)' }}>
                          Read →
                        </span>
                      </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </Card>

          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <Card
              title="You owe a reply"
              count={owedByYou.length}
              collapseAfter={3}
              totalItems={owedByYou.length}
            >
              {(v) => <FollowUpList items={owedByYou} visible={v} empty="Nobody is waiting on you." />}
            </Card>

            <Card
              title="Waiting on them"
              count={waitingOnThem.length}
              collapseAfter={3}
              totalItems={waitingOnThem.length}
            >
              {(v) => (
                <FollowUpList items={waitingOnThem} visible={v} empty="Everyone has come back to you." />
              )}
            </Card>

            {pendingProposals.length > 0 ? (
              <Card title="Learned from what you said" count={pendingProposals.length}>
                <ul className="flex flex-col gap-3">
                  {pendingProposals.map((p) => (
                    <li key={p.id}>
                      {/* Provenance first: she should know why it is being suggested. */}
                      <p className="label mb-1">You have mentioned this a few times</p>
                      <p className="text-[0.93rem]">{p.content}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          className="btn"
                          style={{ padding: '4px 11px', fontSize: '0.78rem' }}
                          disabled={pending !== null}
                          onClick={() =>
                            void run(p.id, () => api.post(`/api/memory/${p.id}/approve`), () => {
                              void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                              void queryClient.invalidateQueries({ queryKey: ['memory'] });
                            })
                          }
                        >
                          {pending === p.id ? 'Saving…' : 'Save as a rule'}
                        </button>
                        <button
                          className="btn btn-quiet"
                          style={{ padding: '4px 11px', fontSize: '0.78rem' }}
                          disabled={pending !== null}
                          onClick={() =>
                            void run(`${p.id}-no`, () => api.post(`/api/memory/${p.id}/dismiss`), () => {
                              void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
                              void queryClient.invalidateQueries({ queryKey: ['memory'] });
                            })
                          }
                        >
                          No thanks
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : (
              <Card title="Ask your assistant">
                <div className="flex flex-col items-start gap-1.5">
                  {['What needs me today?', 'Who is waiting on me?', 'What did I miss?'].map((q) => (
                    <button
                      key={q}
                      className="btn btn-quiet w-full text-left"
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontWeight: 400,
                        padding: '7px 13px',
                        fontSize: '0.92rem',
                      }}
                      onClick={() => onAsk(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
