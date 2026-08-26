import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type MeResponse, type StoredMessage, type ChatResponse } from '../lib/api';
import Message, { type Turn } from '../components/Message';
import { PREVIEWS, findPreview } from '../lib/previews';
import { newId } from '../lib/id';

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

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadedFor = useRef<string | null>(null);
  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, busy]);

  // Load a thread when the shell switches to one.
  useEffect(() => {
    if (activeId === loadedFor.current) return;
    loadedFor.current = activeId;

    if (!activeId) {
      setTurns([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<{ messages: StoredMessage[] }>(`/api/conversations/${activeId}`);
        if (cancelled) return;
        setTurns(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.content,
            steps: m.steps,
            model: m.model,
            durationMs: m.durationMs,
          })),
        );
      } catch {
        if (!cancelled) setTurns([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeId]);

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
    setBusy(true);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    try {
      const res = await api.post<ChatResponse>('/api/assistant/chat', {
        message: trimmed,
        conversationId: activeId ?? undefined,
      });

      loadedFor.current = res.conversationId;
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

  return (
    <>
      <div className="scroll flex-1">
        <div className="mx-auto max-w-[46rem] px-4 py-7 sm:px-6 sm:py-10">
          {turns.length === 0 ? (
            <div className="rise">
              <p className="label mb-4">
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
              <div className="flex flex-col items-start gap-2">
                {(demo ? PREVIEWS.map((p) => p.question) : LIVE_OPENERS).map((opener, i) => (
                  <button
                    key={opener}
                    className="btn btn-quiet rise text-left"
                    style={{
                      fontFamily: 'var(--font-body)',
                      fontWeight: 400,
                      padding: '9px 15px',
                      animationDelay: `${i * 55}ms`,
                    }}
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
            <div className="flex flex-col gap-7">
              {turns.map((turn) => (
                <Message key={turn.id} turn={turn} />
              ))}

              {busy && (
                <p className="label flex items-center gap-1.5">
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
          className="composer mx-auto flex max-w-[46rem] items-end gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            aria-label="Ask your assistant a question"
            placeholder="Ask your assistant…"
            className="max-h-44 flex-1 resize-none bg-transparent px-3 py-2 outline-none"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 176)}px`;
            }}
            onKeyDown={(e) => {
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
            : 'Reads your Outlook · asks before it changes anything'}
        </p>
      </div>
    </>
  );
}
