interface LoadingScreenProps {
  message?: string;
  detail?: string;
}

/**
 * A single loading boundary for whole screens.
 *
 * Pages use this while their first live request is in flight so cached or
 * partially assembled content never flashes before the current view is ready.
 */
export default function LoadingScreen({
  message = 'Preparing your workspace',
  detail = 'Loading the latest information…',
}: LoadingScreenProps) {
  return (
    <div className="loading-screen" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-screen-inner">
        <div className="loading-mark" aria-hidden="true">
          <span>EA</span>
        </div>
        <div>
          <p className="loading-title">{message}</p>
          <p className="loading-detail">{detail}</p>
        </div>
        <span className="loading-progress" aria-hidden="true" />
      </div>
    </div>
  );
}
