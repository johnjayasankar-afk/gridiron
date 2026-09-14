/** The team page's loading frame. The page and the app (while the page's code loads) draw the same frame, so nothing jumps. */
import { ArrowLeft } from 'lucide-react';
import { navigate } from '../app/router';

export function TeamBack() {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => (window.history.length > 1 ? window.history.back() : navigate({ name: 'slate' }))}>
      <ArrowLeft size={14} aria-hidden="true" /> Back
    </button>
  );
}

export function TeamHeroLoading() {
  return (
    <div className="team-hero is-loading" aria-label="Loading the team page">
      <div className="skeleton team-skeleton-emblem" />
      <div className="team-id">
        <div className="skeleton team-skeleton-line" />
        <div className="skeleton team-skeleton-title" />
        <div className="skeleton team-skeleton-line" />
      </div>
    </div>
  );
}

export function TeamPageLoading() {
  return (
    <div className="team" aria-busy="true">
      <div className="team-top">
        <TeamBack />
      </div>
      <TeamHeroLoading />
    </div>
  );
}
