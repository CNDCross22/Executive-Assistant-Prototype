import { useEffect, useState } from 'react';
import type { PendingApproval, Step } from '../lib/api';

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  steps?: Step[];
  /** Set when the turn failed. Failures are shown, never swallowed. */
  failure?: { message: string; detail?: string };
  /** 'direct' means it was answered without a model call. */
  model?: string | null;
  durationMs?: number | null;
  /** Scripted demo reply. Always labelled so it cannot pass as real. */
  preview?: boolean;
  approval?: PendingApproval;
}

function StepList({ steps }: { steps: Step[] }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;

  return (
    <ul className="mb-3 flex flex-col gap-1">
      {steps.map((step, i) => (
        <li key={i} className="label flex items-baseline gap-2">
          <span style={{ color: step.status === 'success' ? 'var(--sage)' : step.status === 'approval_required' ? 'var(--brass)' : 'var(--clay)' }}>
            {step.status === 'success' ? '✓' : step.status === 'approval_required' ? '○' : '✕'}
          </span>
          <span>{step.summary}</span>
        </li>
      ))}
    </ul>
  );
}

function ApprovalCard({ approval, disabled, onDecision }: { approval: PendingApproval; disabled: boolean; onDecision?: (decision: 'Yes' | 'No') => void }) {
  const [expired, setExpired] = useState(() => new Date(approval.expiresAt).getTime() <= Date.now());

  useEffect(() => {
    const remaining = new Date(approval.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [approval.id, approval.expiresAt]);

  const decisionDisabled = disabled || expired;
  return (
    <section className="approval-card" aria-label="Action confirmation">
      <p className="label mb-2">Review before anything changes</p>
      <h3 className="approval-title">{approval.preview.title}</h3>
      <p className="approval-summary">{approval.preview.summary}</p>
      {approval.preview.details.length > 0 && (
        <dl className="approval-details">
          {approval.preview.details.map((detail, index) => (
            <div key={`${index}-${detail.label}`}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
          ))}
        </dl>
      )}
      {approval.preview.warning && <p className="approval-warning">{approval.preview.warning}</p>}
      <p className="mt-4 text-[0.94rem]">{expired ? 'This approval has expired. Prepare the action again to continue.' : 'Would you like me to proceed?'}</p>
      <div className="mt-3 flex gap-2">
        <button className="btn" type="button" disabled={decisionDisabled} onClick={() => onDecision?.('Yes')}>Yes, proceed</button>
        <button className="btn btn-quiet" type="button" disabled={decisionDisabled} onClick={() => onDecision?.('No')}>No, cancel</button>
      </div>
    </section>
  );
}

type CopyBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

function cleanInline(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .trim();
}

/** Turns safe plain text into an executive-readable layout without rendering HTML. */
function StructuredMessage({ text }: { text: string }) {
  const blocks: CopyBlock[] = [];
  let paragraph: string[] = [];
  let list: Extract<CopyBlock, { kind: 'list' }> | null = null;

  const flushParagraph = () => {
    const value = cleanInline(paragraph.join(' '));
    if (value) blocks.push({ kind: 'paragraph', text: value });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.items.length) blocks.push(list);
    list = null;
  };

  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*([^*]{2,60})\*\*:?$/);
    const item = line.match(/^([-*•]|\d+[.)])\s+(.+)$/);

    if (!line) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', text: cleanInline(heading[1] ?? '') });
    } else if (item) {
      flushParagraph();
      const ordered = /^\d/.test(item[1] ?? '');
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { kind: 'list', ordered, items: [] };
      }
      list.items.push(cleanInline(item[2] ?? ''));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();

  return (
    <div className="assistant-copy">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return <h3 key={`${index}-${block.text}`} className="assistant-heading">{block.text}</h3>;
        }
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={`${index}-${block.items[0] ?? ''}`} className={block.ordered ? 'assistant-list ordered' : 'assistant-list'}>
              {block.items.map((item, itemIndex) => <li key={`${itemIndex}-${item}`}>{item}</li>)}
            </List>
          );
        }
        return <p key={`${index}-${block.text.slice(0, 24)}`} className="assistant-paragraph">{block.text}</p>;
      })}
    </div>
  );
}

export default function Message({ turn, onDecision, decisionDisabled = false }: { turn: Turn; onDecision?: (decision: 'Yes' | 'No') => void; decisionDisabled?: boolean }) {
  if (turn.role === 'user') {
    return (
      <div className="rise flex justify-end">
        <p className="bubble-user">{turn.text}</p>
      </div>
    );
  }

  return (
    <div className="rise">
      {Array.isArray(turn.steps) && <StepList steps={turn.steps} />}

      {turn.failure ? (
        <div
          className="rounded-md border-l-2 p-4"
          style={{ background: 'var(--clay-bg)', borderColor: 'var(--clay)' }}
          role="alert"
        >
          <p className="label mb-1" style={{ color: 'var(--clay)' }}>
            Could not complete
          </p>
          <div className="reply"><StructuredMessage text={turn.failure.message} /></div>
          {turn.failure.detail && (
            <p className="mt-1.5 text-[0.9rem]" style={{ color: 'var(--muted)' }}>
              {turn.failure.detail}
            </p>
          )}
        </div>
      ) : (
        <>
          {turn.approval ? (
            <ApprovalCard approval={turn.approval} disabled={decisionDisabled} onDecision={onDecision} />
          ) : (
            <div className="reply"><StructuredMessage text={turn.text} /></div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {turn.preview && (
              <span
                className="label rounded px-1.5 py-0.5"
                style={{ background: 'var(--clay-bg)', color: 'var(--clay)' }}
              >
                Example reply — not a live answer
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
