import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import Card from '../components/Card';
import { useAction } from '../lib/hooks';

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
}

interface MemoryResponse {
  remembered: MemoryEntry[];
  proposed: MemoryEntry[];
  dismissed: MemoryEntry[];
  watching: { signalKey: string; title: string; observedCount: number; needed: number }[];
  proposalThreshold: number;
}

const TYPE_LABEL: Record<string, string> = {
  preference: 'Preference',
  person: 'Person',
  working_style: 'Working style',
  operational: 'Rule for the assistant',
  procedural: 'Procedure',
  historical: 'History',
};

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
  const { run, pending, error, dismissError } = useAction();

  const { data, isLoading } = useQuery({
    queryKey: ['memory'],
    queryFn: () => api.get<MemoryResponse>('/api/memory'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['memory'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label">Reading what I remember…</span>
      </div>
    );
  }

  const remembered = data?.remembered ?? [];
  const proposed = data?.proposed ?? [];
  const watching = data?.watching ?? [];

  return (
    <div className="scroll h-full overflow-x-hidden">
      <div className="mx-auto w-full max-w-[62rem] px-4 py-6 sm:px-6">
        <header className="mb-5">
          <h1 className="h-display mb-2 text-[1.6rem] sm:text-[1.9rem]">What I remember</h1>
          <p className="max-w-xl" style={{ color: 'var(--ink-soft)' }}>
            Everything here shapes how I answer. Nothing is saved unless you told me or agreed to
            it, and you can change or delete any of it.
          </p>
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

        <div className="flex flex-col gap-4">
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
          <Card title="Saved" count={remembered.length}>
            {remembered.length === 0 ? (
              <p style={{ color: 'var(--muted)' }}>
                Nothing yet. Tell me something like “never book me before 9” and I will keep it.
              </p>
            ) : (
              <ul className="flex flex-col gap-px" style={{ background: 'var(--line-soft)' }}>
                {remembered.map((e) => (
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
