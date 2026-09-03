import { useQuery } from '@tanstack/react-query';
import { api, type SetupResponse } from '../lib/api';

/**
 * Shown until every integration is genuinely configured.
 *
 * This exists so the app can never present a working interface over a dead
 * connection. What it lists is read from the server, not assumed.
 */
export default function SetupScreen({ onRecheck }: { onRecheck: () => void }) {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['setup'],
    queryFn: () => api.get<SetupResponse>('/api/setup'),
    refetchInterval: 5000,
  });

  const checks = data?.checks ?? [];
  const done = checks.filter((c) => c.ready).length;

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <p className="label mb-4">Setup</p>
      <h1 className="h-display mb-3 text-4xl">Nearly there</h1>
      <p className="mb-10 max-w-lg" style={{ color: 'var(--ink-soft)' }}>
        The assistant will not show you anything until it is really connected. Fill these in
        and this screen will let itself out.
      </p>

      {data && (
        <p className="label mb-4">
          {done} of {checks.length} ready
        </p>
      )}

      <ul className="mb-10 flex flex-col gap-px" style={{ background: 'var(--line)' }}>
        {checks.map((check) => (
          <li key={check.key} className="flex gap-4 p-5" style={{ background: 'var(--surface)' }}>
            <span
              aria-hidden
              className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]"
              style={{
                background: check.ready ? 'var(--sage-bg)' : 'var(--sunk)',
                color: check.ready ? 'var(--sage)' : 'var(--muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {check.ready ? '✓' : '·'}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="h-display text-base">{check.label}</h2>
              <p className="mt-1 text-[0.94rem]" style={{ color: 'var(--muted)' }}>
                {check.detail}
              </p>
              {!check.ready && check.action && (
                <a
                  href={check.action}
                  target="_blank"
                  rel="noreferrer"
                  className="label mt-2 inline-block underline underline-offset-4"
                  style={{ color: 'var(--brass)' }}
                >
                  Open →
                </a>
              )}
            </div>
            <span className="label shrink-0" style={{ color: check.ready ? 'var(--sage)' : 'var(--muted)' }}>
              {check.ready ? 'Ready' : 'Waiting'}
            </span>
          </li>
        ))}
      </ul>

      <div className="panel mb-8 p-5">
        <p className="label mb-3">Where these go</p>
        <p className="mb-3 text-[0.95rem]" style={{ color: 'var(--ink-soft)' }}>
          All of it lives in one file, <code style={{ fontFamily: 'var(--font-mono)' }}>.env</code>, in the project
          root. Start by copying the example and generating the secrets:
        </p>
        <pre
          className="overflow-x-auto p-4 text-[0.82rem]"
          style={{ background: 'var(--sunk)', fontFamily: 'var(--font-mono)', color: 'var(--ink-soft)' }}
        >
{`cp .env.example .env
npm run gen:secrets`}
        </pre>
      </div>

      {data?.ai && (
        <p className="label mb-8">
          OpenAI · {data.ai.model}
        </p>
      )}

      <button
        className="btn"
        disabled={isFetching}
        onClick={() => {
          void refetch();
          onRecheck();
        }}
      >
        {isFetching ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
}
