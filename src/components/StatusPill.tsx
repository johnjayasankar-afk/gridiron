import { statusShort } from '../../shared/format';
import type { GameSummary } from '../../shared/model';
import { kickoffShort } from '../lib/time';

/** The reported game state. The clock is shown exactly as the provider last reported it; it is never counted down. */
/**
 * `historical` is set while a past play is being looked at.
 *
 * The state handed in is that play's, so the pill would otherwise show the live
 * dot and say "Live" over a moment that finished hours ago: stepping to the
 * first play of a game that ended 35 to 14 announced "Live, Q1 15:00". The clock
 * and the period are still that play's and still shown; what is dropped is the
 * claim that any of it is happening now.
 */
export function StatusPill({ game, stale = false, historical = false }: { game: GameSummary; stale?: boolean; historical?: boolean }) {
  const k = game.status.kind;
  const live = k === 'in_progress' && !historical;
  const tone = live ? 'live' : historical ? 'paused' : k === 'halftime' || k === 'end_of_period' || k === 'delayed' || k === 'suspended' ? 'paused' : k === 'final' ? 'final' : k === 'scheduled' ? 'scheduled' : 'other';
  const text = k === 'scheduled' ? kickoffShort(game.startTime) : statusShort(game.status);
  return (
    <span className={`status-pill tone-${tone}${stale ? ' is-stale' : ''}`}>
      {tone === 'live' && <span className="live-dot" aria-hidden="true" />}
      <span className="sr-only">{tone === 'live' ? 'Live, ' : ''}</span>
      <span className="mono">{text}</span>
    </span>
  );
}
