import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render crash so the Director never sees a white screen.
 *
 * A blank page is the worst possible failure: it gives her nothing to act on
 * and no way to tell whether her data is safe. This shows what happened, says
 * plainly that nothing in her mailbox was touched, and offers a way out.
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console rather than sent anywhere, since this may contain her data.
    console.error('Executive Assistant interface error:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="panel max-w-md rounded-lg p-7" style={{ boxShadow: 'var(--shadow)' }}>
          <p className="label mb-3" style={{ color: 'var(--clay)' }}>
            Something broke on screen
          </p>
          <h1 className="h-display mb-3 text-xl">The interface stopped, not your mailbox</h1>
          <p className="mb-5" style={{ color: 'var(--ink-soft)' }}>
            Nothing was sent, changed or deleted. The assistant only reads your email, and this failure
            happened in the display. Reloading usually clears it.
          </p>

          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              className="btn btn-quiet"
              onClick={() => this.setState({ error: null })}
            >
              Try again without reloading
            </button>
          </div>

          <details className="mt-5">
            <summary className="label cursor-pointer">Technical detail</summary>
            <pre
              className="scroll mt-2 max-h-40 overflow-auto rounded p-3 text-[0.75rem]"
              style={{ background: 'var(--sunk)', fontFamily: 'var(--font-mono)' }}
            >
              {error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
