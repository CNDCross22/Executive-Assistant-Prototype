import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import Card from '../components/Card';
import { useAction, useInitialLoadGate } from '../lib/hooks';
import LoadingScreen from '../components/LoadingScreen';

interface MemoryEntry {
  id: string;
  type: string;
  title: string;
  content: string;
  importance: number;
  source: 'explicit' | 'observed' | 'seeded';
  status: 'active' | 'proposed' | 'dismissed' | 'archived';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  confidence: number;
  sourceRef: string | null;
  scope: 'global' | 'person' | 'project' | 'communication' | 'calendar' | 'email' | 'operational';
  scopeRef: string | null;
  lastUsedAt: string | null;
  lastConfirmedAt: string | null;
  expiresAt: string | null;
  isExpired: boolean;
}

interface MemoryResponse {
  remembered: MemoryEntry[];
  proposed: MemoryEntry[];
  dismissed: MemoryEntry[];
  watching: { signalKey: string; title: string; observedCount: number; needed: number }[];
  proposalThreshold: number;
  conflicts: { firstId: string; secondId: string; reason: string }[];
}

const TYPE_LABEL: Record<string, string> = {
  preference: 'Preference',
  person: 'Person',
  working_style: 'Working style',
  operational: 'Rule for the assistant',
  procedural: 'Procedure',
  historical: 'History',
};
const EMPTY_MEMORY: MemoryEntry[] = [];

/**
 * The types worth offering on a hand-written rule.
 *
 * `historical` is left out deliberately: it records what happened rather than
 * how she wants things done, and it is not hers to write.
 */
const ADDABLE_TYPES = [
  { value: 'preference', label: 'Preference', hint: 'How you want things done. “Never book me before 9am.”' },
  { value: 'working_style', label: 'Working style', hint: 'How you operate. “I read email first thing and after lunch.”' },
  { value: 'operational', label: 'Rule for the assistant', hint: 'How I should behave. “Always show me a draft before sending.”' },
  { value: 'person', label: 'A person', hint: 'A fact about someone. “James is the CFO and approves spend over $5k.”' },
  { value: 'procedural', label: 'Procedure', hint: 'How a task gets done. “Invoices go to accounts@ with the PO number in the subject.”' },
] as const;

type AddableType = (typeof ADDABLE_TYPES)[number]['value'];

/**
 * Everything the assistant believes about her, and the controls to change it.
 *
 * Memory she cannot inspect is memory she cannot trust. This page exists so
 * that every belief is visible, editable and removable — including the ones
 * still waiting to be confirmed, and the patterns not yet raised.
 */
export default function Memory() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'importance' | 'title'>('importance');
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState<AddableType>('preference');
  const [newContent, setNewContent] = useState('');
  const [newSubject, setNewSubject] = useState('');
  const { run, pending, error, dismissError } = useAction();

  const { data, isLoading, isFetching, error: loadError, refetch } = useQuery({
    queryKey: ['memory'],
    queryFn: () => api.get<MemoryResponse>('/api/memory'),
  });
  const initialLoadComplete = useInitialLoadGate(isFetching);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['memory'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const closeAdd = () => {
    setAdding(false);
    setNewContent('');
    setNewSubject('');
    setNewType('preference');
  };

  // A fact about a person is not much use without knowing which person.
  const canSaveNew = newContent.trim().length >= 2 && (newType !== 'person' || newSubject.trim() !== '');

  const saveNew = () =>
    void run(
      'add',
      () =>
        api.post('/api/memory', {
          type: newType,
          content: newContent.trim(),
          ...(newType === 'person' ? { subject: newSubject.trim() } : {}),
        }),
      () => {
        closeAdd();
        refresh();
      },
    );

  // These hooks must run during loading as well as after data arrives.
  const remembered = data?.remembered ?? EMPTY_MEMORY;
  const proposed = data?.proposed ?? EMPTY_MEMORY;
  const watching = data?.watching ?? [];
  const conflictedIds = new Set((data?.conflicts ?? []).flatMap((conflict) => [conflict.firstId, conflict.secondId]));
  const types = [...new Set(remembered.map((entry) => entry.type))];
  const visibleRemembered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return remembered
      .filter((entry) => {
        if (typeFilter !== 'all' && entry.type !== typeFilter) return false;
        return !query || `${entry.title} ${entry.content}`.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        if (sort === 'newest') return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (sort === 'oldest') return Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (sort === 'title') return (a.title || a.content).localeCompare(b.title || b.content);
        return b.importance - a.importance || Number(b.pinned) - Number(a.pinned);
      });
  }, [remembered, search, sort, typeFilter]);

  if (isLoading || !initialLoadComplete) {
    return <LoadingScreen label="Loading preferences" />;
  }

  if (loadError || !data) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="panel max-w-md rounded-xl p-8 text-center shadow-sm">
          <p className="label mb-3">Could not load</p>
          <h1 className="h-display mb-3 text-2xl">Preferences are unavailable</h1>
          <p className="mb-6" style={{ color: 'var(--muted)' }}>
            Nothing stale has been shown.
          </p>
          <button className="btn" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="scroll h-full overflow-x-hidden">
      <div className="mx-auto w-full max-w-[62rem] px-4 py-6 sm:px-6">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label mb-1">Assistant settings</p>
            <h1 className="h-display mb-2 text-[1.6rem] sm:text-[1.9rem]">Preferences and rules</h1>
            <p className="max-w-xl" style={{ color: 'var(--ink-soft)' }}>
              Review what shapes the assistant's answers. Nothing is saved unless you said it or
              approved it, and every item remains under your control.
            </p>
          </div>
          {!adding && (
            <button className="btn shrink-0" onClick={() => setAdding(true)}>
              Add a preference
            </button>
          )}
        </header>

        {/* A write that failed must say so. It used to fail in total silence. */}
        {error && (
          <div
            className="mb-4 flex items-start justify-between gap-3 rounded-lg px-4 py-3"
            style={{ background: 'var(--clay-bg)', border: '1px solid var(--clay)' }}
            role="alert"
          >
            <div>
              <p className="label mb-1" style={{ color: 'var(--clay)' }}>
                That did not save
              </p>
              <p className="text-[0.92rem]">{error}</p>
            </div>
            <button className="text-action shrink-0" onClick={dismissError}>
              Dismiss
            </button>
          </div>
        )}

        <div className="mb-4 grid gap-2 sm:grid-cols-[minmax(14rem,1fr)_auto_auto]">
          <input className="control" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search preferences and rules…" aria-label="Search preferences and rules" />
          <select className="control" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by type">
            <option value="all">All types</option>
            {types.map((type) => <option key={type} value={type}>{TYPE_LABEL[type] ?? type}</option>)}
          </select>
          <select className="control" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Sort preferences">
            <option value="importance">Most important</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Name A–Z</option>
          </select>
        </div>

        <div className="flex flex-col gap-4">
          {/* ---- written by hand ---- */}
          {adding && (
            <Card title="Add a preference">
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="label">What should I remember?</span>
                  <textarea
                    className="panel w-full rounded p-2 text-[0.95rem]"
                    rows={2}
                    autoFocus
                    value={newContent}
                    placeholder={ADDABLE_TYPES.find((t) => t.value === newType)?.hint}
                    onChange={(event) => setNewContent(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') closeAdd();
                      // Enter submits; Shift+Enter is a new line, as in the composer.
                      if (event.key === 'Enter' && !event.shiftKey && canSaveNew) {
                        event.preventDefault();
                        saveNew();
                      }
                    }}
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="label">What kind of thing is it?</span>
                    <select
                      className="control"
                      value={newType}
                      onChange={(event) => setNewType(event.target.value as AddableType)}
                    >
                      {ADDABLE_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                      ))}
                    </select>
                  </label>

                  {newType === 'person' && (
                    <label className="flex flex-col gap-1.5">
                      <span className="label">Who is it about?</span>
                      <input
                        className="control"
                        type="email"
                        value={newSubject}
                        placeholder="james@company.com"
                        onChange={(event) => setNewSubject(event.target.value)}
                      />
                    </label>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn" disabled={pending !== null || !canSaveNew} onClick={saveNew}>
                    {pending === 'add' ? 'Saving…' : 'Save it'}
                  </button>
                  <button className="btn btn-quiet" onClick={closeAdd}>
                    Cancel
                  </button>
                  {/*
                    Said outright rather than inferred, so it applies at once.
                    The observed-pattern route below still proposes and waits —
                    the difference is worth stating where the two sit together.
                  */}
                  <span className="label" style={{ color: 'var(--muted)' }}>
                    Saved straight away. You can edit or forget it at any time.
                  </span>
                </div>
              </div>
            </Card>
          )}

          {/* ---- waiting on her ---- */}
          {proposed.length > 0 && (
            <Card title="Waiting for your decision" count={proposed.length}>
              <p className="label mb-3">These do not affect any answer until you agree.</p>
              <ul className="flex flex-col gap-3">
                {proposed.map((e) => (
                  <li key={e.id} className="rounded p-3" style={{ background: 'var(--brass-soft)' }}>
                    <p className="label mb-1" style={{ color: 'var(--brass)' }}>
                      Noticed from what you said
                    </p>
                    <p>{e.content}</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        className="btn"
                        style={{ padding: '5px 12px', fontSize: '0.8rem' }}
                        disabled={pending !== null}
                        onClick={() => void run(e.id, () => api.post(`/api/memory/${e.id}/approve`), refresh)}
                      >
                        {pending === e.id ? 'Saving…' : 'Save as a rule'}
                      </button>
                      <button
                        className="btn btn-quiet"
                        style={{ padding: '5px 12px', fontSize: '0.8rem' }}
                        disabled={pending !== null}
                        onClick={() =>
                          void run(`${e.id}-no`, () => api.post(`/api/memory/${e.id}/dismiss`), refresh)
                        }
                      >
                        No thanks
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* ---- what it knows ---- */}
          <Card title="Saved preferences" count={visibleRemembered.length}>
            {remembered.length === 0 ? (
              /* Both routes in, since neither is obvious from an empty list. */
              <div style={{ color: 'var(--muted)' }}>
                <p>Nothing yet. There are two ways to change that.</p>
                <ul className="mt-2 flex flex-col gap-1">
                  <li>
                    <button className="text-action" onClick={() => setAdding(true)}>Add one here</button>
                    {' — write the rule yourself and it applies immediately.'}
                  </li>
                  <li>
                    Or tell me in a message — “never book me before 9” — and I will ask you to
                    confirm before saving it.
                  </li>
                </ul>
              </div>
            ) : visibleRemembered.length === 0 ? (
              <div className="py-6 text-center">
                <p className="h-display">No matching preferences</p>
                <button className="text-action mt-2" onClick={() => { setSearch(''); setTypeFilter('all'); }}>Clear filters</button>
              </div>
            ) : (
              <ul className="flex flex-col gap-px" style={{ background: 'var(--line-soft)' }}>
                {visibleRemembered.map((e) => (
                  <li key={e.id} className="px-1 py-3" style={{ background: 'var(--surface)' }}>
                    <div className="mb-1 flex flex-wrap items-baseline gap-2">
                      <span className="label rounded px-1.5 py-0.5" style={{ background: 'var(--sunk)' }}>
                        {TYPE_LABEL[e.type] ?? e.type}
                      </span>
                      {e.source === 'observed' && (
                        <span className="label" style={{ color: 'var(--brass)' }}>
                          you agreed to this
                        </span>
                      )}
                      {e.pinned && <span className="label">pinned</span>}
                      {e.isExpired && <span className="label" style={{ color: 'var(--clay)' }}>expired</span>}
                      {conflictedIds.has(e.id) && <span className="label" style={{ color: 'var(--clay)' }}>conflict, not applied</span>}
                    </div>

                    {editing === e.id ? (
                      <div className="flex flex-col gap-2">
                        <textarea
                          className="panel w-full rounded p-2 text-[0.95rem]"
                          rows={2}
                          autoFocus
                          aria-label="Edit what I remember"
                          value={draft}
                          onChange={(ev) => setDraft(ev.target.value)}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Escape') setEditing(null);
                          }}
                        />
                        <div className="flex gap-2">
                          <button
                            className="btn"
                            style={{ padding: '4px 11px', fontSize: '0.78rem' }}
                            disabled={pending !== null || draft.trim() === ''}
                            onClick={() =>
                              void run(
                                `${e.id}-edit`,
                                () => api.patch(`/api/memory/${e.id}`, { content: draft }),
                                () => {
                                  setEditing(null);
                                  refresh();
                                },
                              )
                            }
                          >
                            {pending === `${e.id}-edit` ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            className="btn btn-quiet"
                            style={{ padding: '4px 11px', fontSize: '0.78rem' }}
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p>{e.content}</p>
                        <p className="label mt-1.5" style={{ color: 'var(--muted)' }}>
                          {e.scopeRef ? `${e.scope}: ${e.scopeRef}` : e.scope}
                          {' · '}{e.source === 'explicit' ? 'you stated this' : e.source === 'observed' ? 'you approved an observed pattern' : 'seeded default'}
                          {e.lastConfirmedAt ? ` · confirmed ${new Date(e.lastConfirmedAt).toLocaleDateString()}` : ''}
                          {e.lastUsedAt ? ` · last used ${new Date(e.lastUsedAt).toLocaleDateString()}` : ''}
                          {e.expiresAt ? ` · expires ${new Date(e.expiresAt).toLocaleString()}` : ''}
                        </p>
                        {forgetting === e.id ? (
                          /*
                            Forgetting a saved rule is irreversible, and it used
                            to happen on a single click. Deleting a chat — far
                            less consequential — always asked. It asks now.
                          */
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="text-[0.88rem]" style={{ color: 'var(--clay)' }}>
                              Forget this permanently?
                            </span>
                            <button
                              className="btn"
                              style={{
                                padding: '4px 11px',
                                fontSize: '0.78rem',
                                background: 'var(--clay)',
                                borderColor: 'var(--clay)',
                                color: 'var(--surface)',
                              }}
                              disabled={pending !== null}
                              onClick={() =>
                                void run(`${e.id}-del`, () => api.del(`/api/memory/${e.id}`), () => {
                                  setForgetting(null);
                                  refresh();
                                })
                              }
                            >
                              {pending === `${e.id}-del` ? 'Forgetting…' : 'Forget it'}
                            </button>
                            <button
                              className="btn btn-quiet"
                              style={{ padding: '4px 11px', fontSize: '0.78rem' }}
                              onClick={() => setForgetting(null)}
                            >
                              Keep it
                            </button>
                          </div>
                        ) : (
                          <div className="mt-2 flex gap-5">
                            <button
                              className="text-action"
                              onClick={() => {
                                setEditing(e.id);
                                setDraft(e.content);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="text-action"
                              style={{ color: 'var(--clay)' }}
                              onClick={() => setForgetting(e.id)}
                            >
                              Forget this
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ---- not yet raised ---- */}
          {watching.length > 0 && (
            <Card title="Patterns I am watching" count={watching.length}>
              <p className="label mb-3">
                Seen once or twice. I will ask you about these after {data?.proposalThreshold ?? 3}{' '}
                sightings. They affect nothing in the meantime.
              </p>
              <ul className="flex flex-col gap-2">
                {watching.map((w) => (
                  <li key={w.signalKey} className="flex items-baseline justify-between gap-3">
                    <span className="text-[0.95rem]" style={{ color: 'var(--ink-soft)' }}>
                      {w.title}
                    </span>
                    <span className="label shrink-0">
                      {w.observedCount} of {w.needed}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <p className="label mt-6 text-center">
          Nothing here comes from the contents of an email — only from what you tell me.
        </p>
      </div>
    </div>
  );
}
