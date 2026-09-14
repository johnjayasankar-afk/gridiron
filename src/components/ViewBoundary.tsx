/** A view that throws shows a recovery panel instead of taking the whole app down. App keys it by route, so navigating resets it. */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reloadForMissingChunk } from '../lib/chunks';

interface ViewBoundaryProps {
  children: ReactNode;
  onHome: () => void;
}

export class ViewBoundary extends Component<ViewBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // A view whose code went missing in a new deploy reloads to fetch the new version.
    if (reloadForMissingChunk(error)) return;
    console.error('Gridiron: a view failed to render.', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="state-block view-error" role="alert">
        <p className="eyebrow">Something went wrong</p>
        <h1 className="state-title">This view could not be shown.</h1>
        <p className="muted">Live data keeps updating in the background. Reload the page, or go back to the slate.</p>
        <details className="view-error-details">
          <summary>Technical details</summary>
          <pre className="mono">{error.message}</pre>
        </details>
        <div className="button-row">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              this.setState({ error: null });
              this.props.onHome();
            }}
          >
            Go to the slate
          </button>
        </div>
      </div>
    );
  }
}
