import type { Step } from '../lib/api';

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
}

function StepList({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;

  return (
    <ul className="mb-3 flex flex-col gap-1">
      {steps.map((step, i) => (
        <li key={i} className="label flex items-baseline gap-2">
          <span style={{ color: step.status === 'success' ? 'var(--sage)' : 'var(--clay)' }}>
            {step.status === 'success' ? '✓' : '✕'}
          </span>
          <span>{step.summary}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Message({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="rise flex justify-end">
        <p className="bubble-user">{turn.text}</p>
      </div>
    );
  }

  return (
    <div className="rise">
      {turn.steps && <StepList steps={turn.steps} />}

      {turn.failure ? (
        <div
          className="rounded-md border-l-2 p-4"
          style={{ background: 'var(--clay-bg)', borderColor: 'var(--clay)' }}
          role="alert"
        >
          <p className="label mb-1" style={{ color: 'var(--clay)' }}>
            Could not complete
          </p>
          <p className="reply">{turn.failure.message}</p>
          {turn.failure.detail && (
            <p className="mt-1.5 text-[0.9rem]" style={{ color: 'var(--muted)' }}>
              {turn.failure.detail}
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="reply">{turn.text}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {turn.preview && (
              <span
                className="label rounded px-1.5 py-0.5"
                style={{ background: 'var(--clay-bg)', color: 'var(--clay)' }}
              >
                Example reply — not a live answer
              </span>
            )}
            {turn.model === 'direct' && !turn.preview && (
              <span className="label" title="Answered from your mailbox directly, with no AI model involved">
                Direct answer · no model used
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
