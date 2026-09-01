import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MeResponse } from '../lib/api';
import Card from '../components/Card';
import MessageViewer from '../components/MessageViewer';
import { useAction, useInitialLoadGate, useTick } from '../lib/hooks';
import LoadingScreen from '../components/LoadingScreen';

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
  priorityScore: number;
  deterministicScore: number;
  executiveAdjustment: number;
  request: string | null;
  decisionRequired: boolean;
  statedDeadline: { statedText: string; evidence: string; parsedDate?: string } | null;
  consequence: string | null;
  impacts: string[];
  recommendation: { action: string; reason: string };
  hasUninspectedAttachments: boolean;
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

type ProactiveEventType = 'security_warning' | 'email_attention' | 'overdue_reply' | 'overdue_follow_up' | 'calendar_conflict' | 'upcoming_meeting';

interface ProactivePolicy {
  eventType: ProactiveEventType;
  enabled: boolean;
  outcome: 'notify' | 'recommend';
  minimumSeverity: 'low' | 'normal' | 'high' | 'critical';
  quietStart: string | null;
  quietEnd: string | null;
  cooldownMinutes: number;
  dailyCap: number;
}

interface ProactiveNotification {
  id: string;
  status: 'unread' | 'read' | 'dismissed' | 'snoozed';
  outcome: 'notify' | 'recommend';
  event: {
    type: ProactiveEventType;
    severity: 'low' | 'normal' | 'high' | 'critical';
    title: string;
    summary: string;
    recommendation: string | null;
    actionLink: string | null;
  };
}

interface ProactiveInbox {
  notifications: ProactiveNotification[];
  unreadCount: number;
  policies: ProactivePolicy[];
  diagnostics: { lastRun: { scannedAt: string; degradedSources: string[]; deliveryMode: 'observe' | 'notify' } | null };
}

interface DashboardResponse {
  generatedAt: string;
  needsYou: DashboardItem[];
  owedByYou: FollowUpItem[];
  waitingOnThem: FollowUpItem[];
  inbox: { unreadCount: number; receivedToday: number; filteredOut: number; considered: number };
  pendingProposals: { id: string; title: string; content: string }[];
  proactive: ProactiveInbox | null;
  user: { displayName: string; firstName: string };
}

type InboxFilter = 'all' | 'unread' | 'urgent' | 'external' | 'warning';
type InboxSort = 'priority' | 'newest' | 'oldest' | 'sender';
const EMPTY_DASHBOARD_ITEMS: DashboardItem[] = [];
const PROACTIVE_LABELS: Record<ProactiveEventType, string> = {
  security_warning: 'Suspicious messages', email_attention: 'Priority email', overdue_reply: 'Replies you owe',
  overdue_follow_up: 'Follow-ups', calendar_conflict: 'Calendar conflicts', upcoming_meeting: 'Upcoming meetings',
};

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
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [sort, setSort] = useState<InboxSort>('priority');
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
  const initialLoadComplete = useInitialLoadGate(isFetching);

  const firstName = data?.user.firstName ?? user.displayName.split(' ')[0] ?? user.displayName;

  // Keep hooks above every loading/error return. React requires the same hook
  // order on the first render and after the mailbox data arrives.
  const needsYou = data?.needsYou ?? EMPTY_DASHBOARD_ITEMS;
  const visibleNeeds = useMemo(() => {
    const query = search.trim().toLowerCase();
    const priority = (item: DashboardItem) => item.priorityScore + (item.warning ? 100 : 0);

    return needsYou
      .filter((item) => {
        if (query && !`${item.from} ${item.fromEmail} ${item.subject} ${item.preview}`.toLowerCase().includes(query)) {
          return false;
        }
        if (filter === 'unread') return item.unread;
        if (filter === 'urgent') return item.importance === 'high';
        if (filter === 'external') return item.external;
        if (filter === 'warning') return Boolean(item.warning);
        return true;
      })
      .sort((a, b) => {
        if (sort === 'newest') return Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
        if (sort === 'oldest') return Date.parse(a.receivedAt) - Date.parse(b.receivedAt);
        if (sort === 'sender') return a.from.localeCompare(b.from);
        return priority(b) - priority(a) || Date.parse(b.receivedAt) - Date.parse(a.receivedAt);
      });
  }, [filter, needsYou, search, sort]);

  if (isLoading || !initialLoadComplete) {
    return <LoadingScreen label="Loading dashboard" />;
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

  const { owedByYou, waitingOnThem, pendingProposals, proactive } = data;
  const filters: { value: InboxFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: needsYou.length },
    { value: 'unread', label: 'Unread', count: needsYou.filter((item) => item.unread).length },
    { value: 'urgent', label: 'Important', count: needsYou.filter((item) => item.importance === 'high').length },
    { value: 'external', label: 'External', count: needsYou.filter((item) => item.external).length },
    { value: 'warning', label: 'Warnings', count: needsYou.filter((item) => Boolean(item.warning)).length },
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
        {/* ---- greeting and mailbox freshness ---- */}
        <header className="shrink-0">
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div>
            <p className="label mb-1">Today</p>
            <h1 className="h-display text-[1.45rem] leading-tight sm:text-[1.75rem]">
              {greeting()}, {firstName}
            </h1>
            </div>
            {/*
              Freshness is stated, live, and can be forced. She has to be able
              to tell at a glance whether she is looking at her mailbox or at a
              memory of it.
            */}
            <div className="flex items-center gap-4">
            <button className="btn btn-quiet hidden sm:block" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => onAsk()}>
              Ask assistant
            </button>
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

        {/* ---- cards: fill remaining height, scroll internally ---- */}
        <div className="grid min-w-0 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,20rem)]">
          <section className="panel flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg">
            <div className="flex flex-col gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="h-display text-[1.05rem]">Priority inbox</h2>
                  <p className="mt-0.5 text-[0.84rem]" style={{ color: 'var(--muted)' }}>
                    {visibleNeeds.length === needsYou.length ? `${needsYou.length} messages need review` : `${visibleNeeds.length} of ${needsYou.length} shown`}
                  </p>
                </div>
                {(search || filter !== 'all') && <button className="text-action" onClick={() => { setSearch(''); setFilter('all'); }}>Clear</button>}
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]">
                <input
                  className="control"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search sender, subject or message…"
                  aria-label="Search priority inbox"
                />
                <select className="control" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Sort messages">
                  <option value="priority">Priority first</option>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="sender">Sender A–Z</option>
                </select>
              </div>
              <div className="filter-strip" aria-label="Filter priority inbox">
                {filters.map((option) => (
                  <button
                    key={option.value}
                    className="filter-chip"
                    aria-pressed={filter === option.value}
                    onClick={() => setFilter(option.value)}
                  >
                    <span>{option.label}</span>
                    <span className="filter-count">{option.count}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="scroll min-h-0 flex-1 px-3 py-1">
            {visibleNeeds.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <p className="h-display">No matching messages</p>
                <p className="mt-1 text-[0.9rem]" style={{ color: 'var(--muted)' }}>Try a different search or clear the filter.</p>
              </div>
            ) : (
              <ul className="flex min-w-0 flex-col">
                {visibleNeeds.map((item, idx) => (
                  <li key={item.ref} style={{ borderTop: idx === 0 ? 'none' : '1px solid var(--line-soft)' }}>
                    <button className="lift block w-full min-w-0 rounded px-2 py-3 text-left" style={{ background: 'none', border: 'none' }} onClick={() => setOpenMessageId(item.id)}>
                      {item.warning && <span className="mb-2 block rounded border-l-2 px-3 py-1.5 text-[0.85rem]" style={{ background: 'var(--clay-bg)', borderColor: 'var(--clay)' }}>{item.warning}</span>}
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-baseline gap-2">
                          {item.unread && <span aria-label="unread" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--brass)' }} />}
                          <span className="truncate" style={{ fontFamily: 'var(--font-display)', fontWeight: item.unread ? 700 : 500, fontSize: '1.02rem' }}>{item.from}</span>
                          {item.importance === 'high' && <span className="label shrink-0" style={{ color: 'var(--clay)' }}>urgent</span>}
                          {item.external && <span className="label hidden shrink-0 sm:inline">external</span>}
                        </span>
                        <span className="label shrink-0">{ago(item.receivedAt)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[0.97rem]">{item.subject}</span>
                      <span className="mt-0.5 block truncate text-[0.87rem]" style={{ color: 'var(--muted)' }}>{item.request ?? item.preview}</span>
                      <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                        {item.decisionRequired && <span className="label" style={{ color: 'var(--clay)' }}>decision required</span>}
                        {item.statedDeadline && <span className="label" style={{ color: 'var(--brass)' }}>deadline: {item.statedDeadline.statedText}</span>}
                        {item.hasUninspectedAttachments && <span className="label">attachment not inspected</span>}
                      </span>
                      <span className="mt-2 flex min-w-0 items-baseline gap-3">
                        <span className="label truncate">{item.reasons.slice(0, 2).join(' · ')}</span>
                        <span className="label ml-auto shrink-0" style={{ color: 'var(--brass)' }}>Open →</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            </div>
          </section>
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            {proactive ? (
              <Card title="Hermes noticed" count={proactive.unreadCount} collapseAfter={3} totalItems={proactive.notifications.length}>
                {(visible) => (
                  <div className="flex flex-col gap-3">
                    {proactive.notifications.length === 0 ? (
                      <p style={{ color: 'var(--muted)' }}>Nothing new needs a reminder.</p>
                    ) : (
                      <ul className="flex flex-col gap-3">
                        {proactive.notifications.slice(0, visible).map((notice) => (
                          <li key={notice.id} className="rounded-md px-3 py-2" style={{ background: notice.status === 'unread' ? 'var(--paper-deep)' : 'transparent', border: '1px solid var(--line-soft)' }}>
                            <p className="label mb-1" style={{ color: notice.event.severity === 'critical' || notice.event.severity === 'high' ? 'var(--clay)' : 'var(--muted)' }}>
                              {PROACTIVE_LABELS[notice.event.type]}
                            </p>
                            <p className="text-[0.94rem]" style={{ fontWeight: notice.status === 'unread' ? 650 : 500 }}>{notice.event.title}</p>
                            <p className="mt-1 text-[0.84rem]" style={{ color: 'var(--muted)' }}>{notice.event.summary}</p>
                            {notice.outcome === 'recommend' && notice.event.recommendation ? <p className="mt-1.5 text-[0.84rem]">{notice.event.recommendation}</p> : null}
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                              {notice.event.actionLink ? <a className="text-action" href={notice.event.actionLink} target="_blank" rel="noreferrer">Open source</a> : null}
                              {notice.status === 'unread' ? (
                                <button className="text-action" disabled={pending !== null} onClick={() => void run(`read-${notice.id}`, () => api.post(`/api/proactive/notifications/${notice.id}/read`), () => void queryClient.invalidateQueries({ queryKey: ['dashboard'] }))}>Mark read</button>
                              ) : null}
                              <button className="text-action" disabled={pending !== null} onClick={() => void run(`snooze-${notice.id}`, () => api.post(`/api/proactive/notifications/${notice.id}/snooze`, { until: new Date(Date.now() + 4 * 3_600_000).toISOString() }), () => void queryClient.invalidateQueries({ queryKey: ['dashboard'] }))}>Snooze 4h</button>
                              <button className="text-action" disabled={pending !== null} onClick={() => void run(`dismiss-${notice.id}`, () => api.post(`/api/proactive/notifications/${notice.id}/dismiss`), () => void queryClient.invalidateQueries({ queryKey: ['dashboard'] }))}>Dismiss</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <details>
                      <summary className="text-action cursor-pointer">Notification settings</summary>
                      <ul className="mt-2 flex flex-col gap-2">
                        {proactive.policies.map((policy) => (
                          <li key={policy.eventType} className="flex items-center justify-between gap-3 text-[0.84rem]">
                            <span>{PROACTIVE_LABELS[policy.eventType]}</span>
                            <label className="label flex items-center gap-2">
                              <input type="checkbox" checked={policy.enabled} disabled={pending !== null} onChange={(event) => void run(`policy-${policy.eventType}`, () => api.patch(`/api/proactive/policies/${policy.eventType}`, { enabled: event.target.checked }), () => void queryClient.invalidateQueries({ queryKey: ['dashboard'] }))} />
                              {policy.enabled ? 'On' : 'Off'}
                            </label>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-[0.78rem]" style={{ color: 'var(--muted)' }}>These settings only control in-app notices. Hermes still asks before consequential actions.</p>
                    </details>
                  </div>
                )}
              </Card>
            ) : null}

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
            ) : null}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
