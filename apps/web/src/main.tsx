import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 503) return false;
        return failureCount < 2;
      },
      /*
        Mailbox data must be fresh: the Director acts on email in minutes, and
        a stale dashboard sends her back to Outlook for good.

        `refetchOnWindowFocus` was off, which was the single worst offender —
        she alt-tabs from Outlook to here and saw whatever was true when she
        left. Coming back to the tab is the strongest possible signal that she
        wants current data.

        Queries that cost money opt OUT of this individually (see the briefing
        in Dashboard.tsx). Everything else is deterministic and effectively
        free to refetch.
      */
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
