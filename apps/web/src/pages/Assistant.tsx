import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type MeResponse, type StoredMessage, type ChatResponse } from '../lib/api';
import Message, { type Turn } from '../components/Message';
import { PREVIEWS, findPreview } from '../lib/previews';
import { newId } from '../lib/id';
import {
  insertMention,
  mentionAtCaret,
  type DirectoryPerson,
  type MentionQuery,
} from '../lib/mentions';
import LoadingScreen from '../components/LoadingScreen';

const LIVE_OPENERS = [
  'What needs me today?',
  'Has anyone not got back to me?',
  'What have I not replied to?',
  'How many unread?',
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

interface Props {
  user: NonNullable<MeResponse['user']>;
  demo: boolean;
  /** Null means a fresh thread. */
  activeId: string | null;
  onConversationStarted: (id: string) => void;
  /** Handed over from the dashboard; asked once, then cleared. */
  initialQuestion?: string | null;
  onInitialQuestionConsumed?: () => void;
}

export default function Assistant({
  user,
  demo,
  activeId,
  onConversationStarted,
  initialQuestion,
  onInitialQuestionConsumed,
}: Props) {
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState(false);
  const [activePerson, setActivePerson] = useState(0);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(false);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});

  const mentionQuery = mention?.query ?? '';

  useEffect(() => {
    if (!mention || !mentionQuery || demo) {
      setPeople([]);
      setPeopleLoading(false);
      setPeopleError(false);
      setActivePerson(0);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPeopleLoading(true);
      setPeopleError(false);
      void api
        .get<{ people: DirectoryPerson[] }>(`/api/directory/search?q=${encodeURIComponent(mentionQuery)}`)
        .then((result) => {
          if (cancelled) return;
          setPeople(result.people);
          setActivePerson(0);
        })
        .catch(() => {
          if (cancelled) return;
          setPeople([]);
          setPeopleError(true);
        })
        .finally(() => {
          if (!cancelled) setPeopleLoading(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [demo, mentionQuery]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, busy]);

  // Load a thread when the shell switches to one.
  useEffect(() => {
    if (activeId === loadedConversationId) return;

    if (!activeId) {
      setTurns([]);
      setLoadedConversationId(null);
      setThreadLoading(false);
      setThreadError(false);
      return;
    }

    let cancelled = false;
    setTurns([]);
    setThreadLoading(true);
    setThreadError(false);
    void (async () => {
      try {
        const data = await api.get<{ messages: StoredMessage[] }>(`/api/conversations/${activeId}`);
        if (cancelled) return;
        setTurns(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.content,
            steps: Array.isArray(m.steps) ? m.steps : [],
            approval: m.approval,
            model: m.model,
            durationMs: m.durationMs,
          })),
        );
        setLoadedConversationId(activeId);
      } catch {
        if (!cancelled) {
          setTurns([]);
          setLoadedConversationId(activeId);
          setThreadError(true);
        }
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeId, loadedConversationId]);

  /**
   * Play a scripted exchange so the chat can be seen populated before there
   * are AI credits. Demo mode only, and every reply is badged as an example.
   */
  async function playPreview(question: string) {
    const preview = findPreview(question);
    if (!preview) return false;

    setTurns((t) => [...t, { id: newId(), role: 'user', text: question }]);
    setInput('');
    setBusy(true);

    // A brief pause so the working indicator is visible, as it would be live.
    await new Promise((r) => setTimeout(r, preview.model === 'direct' ? 260 : 900));

    setTurns((t) => [
      ...t,
      {
        id: newId(),
        role: 'assistant',
        text: preview.reply,
        steps: preview.steps,
        model: preview.model,
        durationMs: preview.durationMs,
        preview: true,
      },
    ]);
    setBusy(false);
    return true;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setTurns((t) => [...t, { id: newId(), role: 'user', text: trimmed }]);
    setInput('');
    setMention(null);
    setBusy(true);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    try {
      const res = await api.post<ChatResponse>('/api/assistant/chat', {
        message: trimmed,
        conversationId: activeId ?? undefined,
      });

      setLoadedConversationId(res.conversationId);
      onConversationStarted(res.conversationId);

      setTurns((t) => [
        ...t,
        {
          id: newId(),
          role: 'assistant',
          text: res.reply,
          steps: res.steps,
          model: res.meta.model,
          durationMs: res.meta.durationMs,
          approval: res.approval,
        },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['setup'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      const e = err as ApiError;
      setTurns((t) => [
        ...t,
        {
          id: newId(),
          role: 'assistant',
          text: '',
          failure: { message: e.message ?? 'Something went wrong.', detail: e.detail },
        },
      ]);
      // Give her words back so a failure does not cost her the question.
      setInput(trimmed);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  sendRef.current = send;

  // A question handed over from the dashboard fires once.
  useEffect(() => {
    if (!initialQuestion) return;
    void sendRef.current(initialQuestion);
    onInitialQuestionConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const firstName = user.displayName.split(' ')[0] ?? user.displayName;

  function updateMention(value: string, caret: number | null) {
    setMention(mentionAtCaret(value, caret ?? value.length));
  }

  function choosePerson(person: DirectoryPerson) {
    if (!mention) return;
    const inserted = insertMention(input, mention, person);
    setInput(inserted.value);
    setMention(null);
    setPeople([]);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  }

  if (threadLoading || activeId !== loadedConversationId) {
    return <LoadingScreen message="Opening conversation" detail="Loading the complete thread…" />;
  }

  if (threadError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="panel max-w-md rounded-xl p-8 text-center shadow-sm">
          <p className="label mb-3">Could not load</p>
          <h1 className="h-display mb-3 text-2xl">This conversation is unavailable</h1>
          <p className="mb-6" style={{ color: 'var(--muted)' }}>
            The previous thread was cleared so it could not be mistaken for this one.
          </p>
          <button
            className="btn"
            onClick={() => {
              setThreadError(false);
              setLoadedConversationId(null);
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="scroll flex-1">
        <div className="mx-auto max-w-[46rem] px-4 py-7 sm:px-6 sm:py-10">
          {turns.length === 0 ? (
            <div className="rise">
               <p className="label mb-4">Director's assistant · {' '}
                {new Date().toLocaleDateString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
              </p>
              <h1 className="h-display mb-3 text-[1.8rem] leading-[1.12] sm:text-[2.4rem]">
                {greeting()}, {firstName}
              </h1>
              <p className="mb-10 max-w-md" style={{ color: 'var(--ink-soft)' }}>
                Ask me about your inbox or who is waiting on you. I will tell you what I actually
                find — and check with you before I change anything.
              </p>

              <p className="label mb-3">{demo ? 'See how a reply looks' : 'Try'}</p>
               <div className="grid max-w-[40rem] gap-2 sm:grid-cols-2">
                {(demo ? PREVIEWS.map((p) => p.question) : LIVE_OPENERS).map((opener, i) => (
                  <button
                    key={opener}
                    className="btn btn-quiet rise text-left"
                    style={{ padding: '10px 15px', animationDelay: `${i * 55}ms` }}
                    onClick={() => void (demo ? playPreview(opener) : send(opener))}
                  >
                    {opener}
                  </button>
                ))}
              </div>
              {demo && (
                <p className="label mt-4 max-w-md leading-relaxed">
                  These play scripted examples so you can see the interface. Type your own
                  question to use the real assistant.
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-7" aria-live="polite">
              {turns.map((turn, index) => (
                <Message
                  key={turn.id}
                  turn={turn}
                  onDecision={(decision) => void send(decision)}
                  decisionDisabled={busy || turns.slice(index + 1).some((later) => later.role === 'user')}
                />
              ))}

              {busy && (
                <p className="label flex items-center gap-1.5" role="status">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="ml-1.5">Working</span>
                </p>
              )}
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6 sm:pb-5">
        <form
          className="composer relative mx-auto flex max-w-[46rem] items-end gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          {mention && !demo && (
            <div id="directory-people" className="mention-picker" role="listbox" aria-label="People in the Arete Care directory">
              {!mentionQuery ? (
                <p className="mention-status">Type a colleague's name</p>
              ) : peopleLoading ? (
                <p className="mention-status">Searching the directory&hellip;</p>
              ) : peopleError ? (
                <p className="mention-status mention-status-error">The directory could not be reached.</p>
              ) : people.length === 0 ? (
                <p className="mention-status">No matching Arete Care account</p>
              ) : (
                people.map((person, index) => (
                  <button
                    key={person.email}
                    id={`directory-person-${index}`}
                    className={`mention-person${index === activePerson ? ' is-active' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={index === activePerson}
                    onMouseEnter={() => setActivePerson(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choosePerson(person)}
                  >
                    <span className="mention-avatar" aria-hidden="true">
                      {person.name.trim().charAt(0).toUpperCase() || '?'}
                    </span>
                    <span className="mention-identity">
                      <strong>{person.name}</strong>
                      <span>{person.email}</span>
                    </span>
                    {person.jobTitle && <span className="mention-role">{person.jobTitle}</span>}
                  </button>
                ))
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            aria-label="Ask your assistant a question"
            aria-autocomplete="list"
            aria-expanded={Boolean(mention && !demo)}
            aria-controls={mention && !demo ? 'directory-people' : undefined}
            aria-activedescendant={people.length > 0 ? `directory-person-${activePerson}` : undefined}
            placeholder="Ask your assistant…"
            className="max-h-44 flex-1 resize-none bg-transparent px-3 py-2 outline-none"
            onChange={(e) => {
              setInput(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 176)}px`;
            }}
            onSelect={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (mention && people.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActivePerson((current) => (current + 1) % people.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActivePerson((current) => (current - 1 + people.length) % people.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  choosePerson(people[activePerson]!);
                  return;
                }
              }
              if (mention && e.key === 'Escape') {
                e.preventDefault();
                setMention(null);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          <button className="btn" type="submit" disabled={busy || !input.trim()}>
            Ask
          </button>
        </form>
        <p className="label mx-auto mt-2.5 max-w-[46rem] text-center">
          {demo
            ? 'Demo mailbox · no real email is being read'
            : 'Reads your Outlook · shows a preview and asks before making changes'}
        </p>
      </div>
    </>
  );
}
