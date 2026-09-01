import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MeResponse } from '../lib/api';
import { useAction, useInitialLoadGate } from '../lib/hooks';
import LoadingScreen from '../components/LoadingScreen';

interface BriefingResponse {
  available: boolean;
  text: string;
  generatedAt: string;
  unavailableReason?: string;
  cached: boolean;
}

const SECTION_TITLES = [
  'OVERVIEW',
  'SECURITY NOTE',
  'NEEDS YOUR ATTENTION',
  'FOLLOW-UPS',
  'WORTH KNOWING',
  'CAN WAIT',
] as const;

function StructuredReport({ text }: { text: string }) {
  const headingPattern = new RegExp(`^(${SECTION_TITLES.join('|')}):?\\s*(.*)$`, 'i');
  const lines = text.replace(/\r/g, '').split('\n');
  type ReportBlock = { text: string; listItem: boolean };
  const sections: { title: string; blocks: ReportBlock[] }[] = [];
  let current = { title: 'OVERVIEW', blocks: [] as ReportBlock[] };
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const value = paragraph.join(' ').trim();
    if (value) current.blocks.push({ text: value, listItem: false });
    paragraph = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (current.blocks.length) sections.push(current);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*(.*?)\*\*$/, '$1');
    const heading = line.match(headingPattern);
    if (heading) {
      flushSection();
      current = { title: (heading[1] ?? 'OVERVIEW').toUpperCase(), blocks: [] };
      if (heading[2]?.trim()) current.blocks.push({ text: heading[2].trim(), listItem: false });
    } else if (!line) {
      flushParagraph();
    } else if (/^(?:[-*•]\s+|\d+[.)]\s+)/.test(line)) {
      flushParagraph();
      current.blocks.push({
        text: line.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '').trim(),
        listItem: true,
      });
    } else {
      paragraph.push(line);
    }
  }
  flushSection();

  return (
    <div className="executive-report">
      {sections.map((section) => (
        <section
          key={`${section.title}-${section.blocks[0] ?? ''}`}
          className={section.title === 'SECURITY NOTE' ? 'report-section report-section-warning' : 'report-section'}
        >
          <h2>{section.title === 'FOLLOW-UPS' ? 'Follow-ups' : section.title.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())}</h2>
          <div className="report-section-body">
            {section.blocks.map((block, index) => {
              const showNumber = block.listItem &&
                (section.title === 'NEEDS YOUR ATTENTION' || section.title === 'FOLLOW-UPS');
              const itemNumber = section.blocks.slice(0, index + 1).filter((candidate) => candidate.listItem).length;
              return (
                <div
                  className={showNumber ? 'report-item' : ''}
                  key={`${index}-${block.text.slice(0, 30)}`}
                >
                  {showNumber && <span className="report-number" aria-hidden>{itemNumber}</span>}
                  <p>{block.text}</p>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function Briefing({ user }: { user: NonNullable<MeResponse['user']> }) {
  const queryClient = useQueryClient();
  const { run, pending, error: refreshError, dismissError } = useAction();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['briefing'],
    queryFn: () => api.get<BriefingResponse>('/api/dashboard/briefing'),
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const initialLoadComplete = useInitialLoadGate(isFetching);

  const firstName = user.displayName.split(' ')[0] ?? user.displayName;

  if (isLoading || !initialLoadComplete) {
    return <LoadingScreen message="Preparing your briefing" detail="Loading the current report…" />;
  }

  return (
    <div className="scroll h-full overflow-x-hidden">
      <main className="mx-auto w-full max-w-[62rem] px-4 py-7 sm:px-6 sm:py-10">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label mb-1" style={{ color: 'var(--brass)' }}>Executive report</p>
            <h1 className="h-display text-[1.8rem] leading-tight sm:text-[2.25rem]">Your briefing, {firstName}</h1>
            <p className="mt-2 max-w-xl" style={{ color: 'var(--ink-soft)' }}>
              A considered view of what needs attention, what is outstanding, and what can wait.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            {data?.generatedAt && (
              <p className="label">
                Last prepared {new Date(data.generatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            <button
              className="btn"
              disabled={pending !== null || isLoading}
              onClick={() => void run('briefing', () => api.get('/api/dashboard/briefing?refresh=true'), () => queryClient.invalidateQueries({ queryKey: ['briefing'] }))}
            >
              {pending === 'briefing' ? 'Preparing report…' : 'Refresh report'}
            </button>
          </div>
        </header>

        {refreshError && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg px-4 py-3" style={{ background: 'var(--clay-bg)', border: '1px solid var(--clay)' }} role="alert">
            <p>{refreshError}</p>
            <button className="text-action" onClick={dismissError}>Dismiss</button>
          </div>
        )}

        <article className="panel min-h-[24rem] rounded-xl px-5 py-6 shadow-sm sm:px-8 sm:py-8">
          {isLoading || pending === 'briefing' ? (
            <div className="report-skeleton" role="status" aria-label="Reviewing your inbox">
              <span className="skeleton-line skeleton-label" />
              <span className="skeleton-line skeleton-wide" />
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-short" />
              <span className="skeleton-line skeleton-label mt-5" />
              <span className="skeleton-card" />
              <span className="skeleton-card" />
            </div>
          ) : error || !data ? (
            <div className="py-16 text-center">
              <h2 className="h-display text-[1.2rem]">The report could not be loaded</h2>
              <p className="mt-2" style={{ color: 'var(--muted)' }}>Your mailbox has not been changed.</p>
            </div>
          ) : data.available ? (
            <>
              {data.unavailableReason && (
                <p className="mb-5 rounded-lg px-4 py-3 text-[0.92rem]" style={{ background: 'var(--paper-warm)', color: 'var(--ink-soft)', border: '1px solid var(--line-soft)' }} role="status">
                  {data.unavailableReason}
                </p>
              )}
              <StructuredReport text={data.text} />
              <footer className="label mt-8 border-t pt-4" style={{ borderColor: 'var(--line-soft)' }}>
                {data.cached ? 'Current cached report' : 'Freshly prepared'}
                {' · '}
                {new Date(data.generatedAt).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
              </footer>
            </>
          ) : (
            <div className="py-16 text-center">
              <h2 className="h-display text-[1.2rem]">No written briefing available</h2>
              <p className="mx-auto mt-2 max-w-lg" style={{ color: 'var(--muted)' }}>{data.unavailableReason}</p>
            </div>
          )}
        </article>
      </main>
    </div>
  );
}
