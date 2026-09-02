import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useEscape } from '../lib/hooks';
import Icon from './Icon';

interface Address {
  name: string;
  address: string;
}

interface FullMessage {
  id: string;
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  receivedAt: string;
  isRead: boolean;
  isExternal: boolean;
  importance: 'low' | 'normal' | 'high';
  hasAttachments: boolean;
  attachments: Array<{
    name: string;
    contentType: string;
    size: number;
    isInline: boolean;
    kind: 'file' | 'item' | 'reference' | 'unknown';
    textSupported: boolean;
  }>;
  webLink: string;
  /** Plain text. The API strips HTML before it ever reaches us. */
  body: string;
  warning?: string;
  warningDetail?: string;
}

/**
 * Reading pane.
 *
 * Slides in over the dashboard rather than pushing it around, and scrolls
 * inside itself so a long email never grows the page.
 *
 * The body is rendered as TEXT, never as HTML. The API strips markup before
 * sending it. Rendering a stranger's HTML in the Director's browser is an XSS
 * vector, and not having markup at all beats sanitising it.
 */
export default function MessageViewer({
  messageId,
  onClose,
  onAsk,
}: {
  messageId: string;
  onClose: () => void;
  onAsk: (question: string) => void;
}) {
  // A reading pane you can only leave by finding the Close link is a trap.
  useEscape(true, onClose);

  const { data, isLoading, error } = useQuery({
    queryKey: ['message', messageId],
    queryFn: () => api.get<FullMessage>(`/api/mail/message?id=${encodeURIComponent(messageId)}`),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Scrim is desktop-only; on a phone the sheet takes the whole screen. */}
      <button
        className="scrim hidden flex-1 sm:block"
        style={{ background: 'rgb(0 0 0 / 0.35)', border: 'none' }}
        aria-label="Close message"
        onClick={onClose}
      />

      <div
        className="sheet-right flex h-full w-full flex-col sm:max-w-[42rem]"
        style={{ background: 'var(--surface)', borderLeft: '1px solid var(--line)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Message"
      >
        {/* header */}
        <div
          className="flex shrink-0 items-center justify-between gap-4 px-4 py-3 sm:px-6"
          style={{ borderBottom: '1px solid var(--line)' }}
        >
          <span className="label">Message</span>
          <div className="flex items-center gap-4">
            {data?.webLink && (
              <a
                href={data.webLink}
                target="_blank"
                rel="noreferrer"
                className="label underline underline-offset-2"
                style={{ color: 'var(--brass)' }}
              >
                Open in Outlook →
              </a>
            )}
            <button className="icon-button" onClick={onClose} aria-label="Close message" title="Close message">
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="scroll min-h-0 flex-1 px-4 py-5 sm:px-6">
          {isLoading ? (
            <p className="label">Fetching the message…</p>
          ) : error || !data ? (
            <div>
              <p className="label mb-2" style={{ color: 'var(--clay)' }}>
                Could not open it
              </p>
              <p style={{ color: 'var(--ink-soft)' }}>
                Microsoft would not return that message. It may have been moved or deleted.
              </p>
            </div>
          ) : (
            <article>
              {data.warning && (
                <div
                  className="mb-5 rounded border-l-2 px-4 py-3"
                  style={{ background: 'var(--clay-bg)', borderColor: 'var(--clay)' }}
                  role="alert"
                >
                  <p className="label mb-1" style={{ color: 'var(--clay)' }}>
                    Treat with caution
                  </p>
                  <p className="text-[0.95rem]">{data.warning}</p>
                  {data.warningDetail && (
                    <p className="mt-1 text-[0.85rem]" style={{ color: 'var(--muted)' }}>
                      It {data.warningDetail}.
                    </p>
                  )}
                </div>
              )}

              <h1 className="h-display mb-4 text-[1.25rem] leading-snug sm:text-[1.45rem]">{data.subject}</h1>

              <div className="mb-5 flex flex-col gap-1 pb-4" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                    {data.from?.name ?? 'Unknown sender'}
                  </span>
                  <span className="label">{data.from?.address}</span>
                  {data.isExternal && (
                    <span
                      className="label rounded px-1.5 py-0.5"
                      style={{ background: 'var(--sunk)' }}
                    >
                      external
                    </span>
                  )}
                  {data.importance === 'high' && (
                    <span
                      className="label rounded px-1.5 py-0.5"
                      style={{ background: 'var(--clay-bg)', color: 'var(--clay)' }}
                    >
                      high importance
                    </span>
                  )}
                </div>

                <p className="label">
                  To {data.to.map((r) => r.name || r.address).join(', ') || 'you'}
                  {data.cc.length > 0 && ` · cc ${data.cc.length}`}
                  {' · '}
                  {new Date(data.receivedAt).toLocaleString(undefined, {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {data.hasAttachments && ' · has attachments'}
                </p>
              </div>

              {/* Plain text, deliberately. */}
              <div className="reply" style={{ whiteSpace: 'pre-wrap' }}>
                {data.body || <span style={{ color: 'var(--muted)' }}>This message has no text body.</span>}
              </div>

              {data.attachments.length > 0 && (
                <section className="mt-6 pt-4" style={{ borderTop: '1px solid var(--line-soft)' }} aria-label="Attachments">
                  <p className="label mb-2">Attachments</p>
                  <div className="flex flex-col gap-2">
                    {data.attachments.map((attachment, index) => (
                      <div key={`${attachment.name}-${index}`} className="rounded px-3 py-2" style={{ background: 'var(--sunk)' }}>
                        <p className="text-[0.95rem]" style={{ fontWeight: 600 }}>{attachment.name}</p>
                        <p className="label mt-0.5">
                          {attachment.kind} · {Math.max(1, Math.ceil(attachment.size / 1024)).toLocaleString()} KB
                          {attachment.textSupported ? ' · text can be inspected by Hermes' : ' · metadata only'}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="label mt-2">Attachments are not executed or malware-scanned.</p>
                </section>
              )}
            </article>
          )}
        </div>

        {/* actions */}
        {data && (
          <div className="shrink-0 px-4 py-3 sm:px-6" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-quiet"
                style={{ fontFamily: 'var(--font-body)', fontWeight: 400, padding: '7px 13px' }}
                onClick={() => {
                  onAsk(`What does the message from ${data.from?.name ?? 'them'} about "${data.subject}" actually want?`);
                  onClose();
                }}
              >
                Ask your assistant
              </button>
              <a
                href={data.webLink}
                target="_blank"
                rel="noreferrer"
                className="btn btn-quiet no-underline"
                style={{ fontFamily: 'var(--font-body)', fontWeight: 400, padding: '7px 13px' }}
              >
                Reply in Outlook
              </a>
            </div>
            <p className="label mt-2">
              Any reply, move or delete still requires a separate approval.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
