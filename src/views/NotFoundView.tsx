/** An address Gridiron does not know: a clear way back, never a blank page. */
import { ArrowLeft } from 'lucide-react';
import { useEffect } from 'react';
import { navigate, useLocation } from '../app/router';

export function NotFoundView() {
  const { href } = useLocation();
  useEffect(() => {
    document.title = 'Page not found · Gridiron';
  }, []);
  return (
    <div className="state-block not-found">
      <p className="not-found-code mono" aria-hidden="true">
        404
      </p>
      <p className="eyebrow">Off the field</p>
      <h1 className="state-title">There is no page at this address.</h1>
      <p className="not-found-path mono">{href}</p>
      <p className="muted">The link may be old or mistyped. Every game of the day is on the slate.</p>
      <div className="button-row">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate({ name: 'slate' })}>
          <ArrowLeft size={14} aria-hidden="true" /> Go to the slate
        </button>
      </div>
    </div>
  );
}
