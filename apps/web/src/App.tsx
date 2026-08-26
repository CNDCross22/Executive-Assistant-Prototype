import { useQuery } from '@tanstack/react-query';
import { api, type MeResponse } from './lib/api';
import SetupScreen from './pages/SetupScreen';
import SignIn from './pages/SignIn';
import Workspace from './pages/Workspace';

export default function App() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/api/auth/me'),
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="label">Starting</span>
      </div>
    );
  }

  // The server is unreachable. Say so plainly rather than showing an empty app.
  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="panel max-w-md p-8 text-center">
          <p className="label mb-3">Not connected</p>
          <h1 className="h-display mb-3 text-2xl">The Executive Assistant server is not responding</h1>
          <p className="mb-6" style={{ color: 'var(--muted)' }}>
            Start it with <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9em' }}>npm run dev:api</code>{' '}
            and try again.
          </p>
          <button className="btn" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Setup comes first. We never show a working interface over a dead integration.
  if (!data.setup.ready) return <SetupScreen onRecheck={() => void refetch()} />;

  if (!data.authenticated) return <SignIn />;

  return <Workspace user={data.user!} microsoft={data.microsoft} demo={data.demo ?? false} />;
}
