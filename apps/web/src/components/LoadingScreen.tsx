interface LoadingScreenProps {
  label?: string;
}

/**
 * A single loading boundary for whole screens.
 *
 * Pages use this while their first live request is in flight so cached or
 * partially assembled content never flashes before the current view is ready.
 */
export default function LoadingScreen({ label = 'Loading' }: LoadingScreenProps) {
  return (
    <div className="loading-screen" role="status" aria-label={label} aria-live="polite" aria-busy="true">
      <span className="loading-spinner" aria-hidden="true" />
    </div>
  );
}
