/**
 * The frame a page draws while its own code is still on the way.
 *
 * A route is split into its own chunk, so between the click and the page there
 * is a moment with the chunk requested and nothing to render. `fallback={null}`
 * spends that moment showing an empty main area: the header and the rail stay,
 * the middle of the window goes blank, and then the page appears. On a fast
 * connection it is a flicker; on a slow one it reads as the app having lost
 * the page.
 *
 * These draw what the page itself draws while it waits for its data, so the
 * handover from this to the real page changes nothing on screen. The team page
 * already worked this way (see TeamLoading); this is the same idea for the two
 * routes that were still blank.
 */
import { ArrowLeft } from 'lucide-react';
import { navigate } from '../app/router';

function Back({ label }: { label: string }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm state-back" onClick={() => navigate({ name: 'slate' })}>
      <ArrowLeft size={14} aria-hidden="true" /> {label}
    </button>
  );
}

/** Matches the block DetailView shows while it waits for the game summary. */
export function GamePageLoading() {
  return (
    <div className="state-block" aria-busy="true">
      <Back label="Slate" />
      <p className="eyebrow">Game</p>
      <h1 className="state-title">Loading the game</h1>
      <p className="muted">Requesting the game summary from the provider.</p>
    </div>
  );
}

export function TapePageLoading() {
  return (
    <div className="state-block" aria-busy="true">
      <Back label="Slate" />
      <p className="eyebrow">Tape</p>
      <h1 className="state-title">Loading the tape</h1>
      <p className="muted">Laying out every drive in the slate.</p>
    </div>
  );
}
