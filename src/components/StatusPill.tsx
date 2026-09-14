import { statusShort } from '../../shared/format';
import type { GameSummary } from '../../shared/model';
import { kickoffShort } from '../lib/time';

/** The reported game state. The clock is shown exactly as the provider last reported it; it is never counted down. */
export function StatusPill({ game, stale = false }: { game: GameSummary; stale?: boolean }) {
  const k = game.status.kind;
  const tone = k === 'in_progress' ? 'live' : k === 'halftime' || k === 'end_of_period' || k === 'delayed' || k === 'suspended' ? 'paused' : k === 'final' ? 'final' : k === 'scheduled' ? 'scheduled' : 'other';
  const text = k === 'scheduled' ? kickoffShort(game.startTime) : statusShort(game.status);
  return (
    <span className={`status-pill tone-${tone}${stale ? ' is-stale' : ''}`}>
      {tone === 'live' && <span className="live-dot" aria-hidden="true" />}
      <span className="sr-only">{tone === 'live' ? 'Live, ' : ''}</span>
      <span className="mono">{text}</span>
    </span>
  );
}
