import { Pin, PinOff, Radio, SkipForward } from 'lucide-react';
import type { GameSummary } from '../../shared/model';
import { useNow } from '../lib/motion';
import { kickoffShort } from '../lib/time';
import { useDirector } from '../state/director';
import { IconButton } from './controls';

function followingFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The scheduled game that kicks off soonest, shown while nothing is live. */
export function nextKickoff(games: GameSummary[]): GameSummary | null {
  const time = (g: GameSummary) => (g.startTime ? Date.parse(g.startTime) : Number.POSITIVE_INFINITY);
  return games.filter((g) => g.status.kind === 'scheduled').sort((a, b) => time(a) - time(b))[0] ?? null;
}

/** The strip above a Director slot: what it follows, why, and the viewer's stay and skip controls. */
export function DirectorRibbon({ game, next = null }: { game: GameSummary | null; next?: GameSummary | null }) {
  const state = useDirector((s) => s.state);
  const now = useNow(5000);
  return (
    <div className={`director-ribbon${state.locked ? ' is-locked' : ''}`} role="group" aria-label="Director">
      <span className="director-badge mono">
        <Radio size={13} strokeWidth={2} aria-hidden="true" />
        Director
      </span>
      <span className="director-reason" title={game && state.reason ? `${game.away.abbreviation} at ${game.home.abbreviation} · ${state.reason}` : undefined}>
        {game ? (
          <>
            <strong>
              {game.away.abbreviation} at {game.home.abbreviation}
            </strong>
            {state.reason ? <span className="director-why"> · {state.reason}</span> : null}
          </>
        ) : next ? (
          <>
            <strong>Up next</strong>
            <span className="director-why">
              {' '}
              · {next.away.abbreviation} at {next.home.abbreviation}, kickoff {kickoffShort(next.startTime)}
            </span>
          </>
        ) : (
          'Waiting for a live game'
        )}
      </span>
      {game && <span className="director-since mono">{state.locked ? 'staying' : followingFor(now - state.since)}</span>}
      {game && (
        <span className="director-actions">
          <IconButton label={state.locked ? 'Let the director move on' : 'Stay on this game'} icon={state.locked ? PinOff : Pin} pressed={state.locked} onClick={() => useDirector.getState().lock(!state.locked)} />
          <IconButton label="Skip this game for 3 minutes" icon={SkipForward} onClick={() => useDirector.getState().skip(Date.now())} />
        </span>
      )}
    </div>
  );
}
