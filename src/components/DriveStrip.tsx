/**
 * A card's drive strip, laid over the bottom edge of its field: the 100-yard
 * field with where the drive started, where each reported play ended, the line
 * to gain and the ball. It is drawn from reported spots only. When the provider
 * has not reported the drive, the strip says so instead of drawing one.
 */
import { memo, useMemo, type CSSProperties } from 'react';
import { describeDrive, driveOutcome, driveStats, driveTrack, hasDrivePosition, type DriveTrack } from '../../shared/driveTrack';
import { teamFor } from '../../shared/format';
import type { GameSummary, Situation } from '../../shared/model';
import { accentFor } from '../field/color';
import { useIsDark } from '../lib/theme';
import type { DetailState } from '../state/live';

const clamp = (yard: number) => Math.min(100, Math.max(0, yard));
const at = (yard: number): CSSProperties => ({ left: `${clamp(yard)}%` });

function Marks({ track }: { track: DriveTrack }) {
  const { start, ball, lineToGain } = track;
  const range = start !== null && ball !== null ? { left: clamp(Math.min(start, ball)), right: clamp(Math.max(start, ball)), ballLeft: ball < start } : null;
  return (
    <>
      {range && <span className={`dstrip-range${range.ballLeft ? ' is-ball-left' : ''}`} style={{ left: `${range.left}%`, width: `${range.right - range.left}%` }} />}
      {track.plays.map((p) => (p.to === null ? null : <span key={p.id} className={`dstrip-tick tone-${p.tone}`} style={at(p.to)} />))}
      {start !== null && <span className="dstrip-start" style={at(start)} />}
      {lineToGain !== null && <span className="dstrip-ltg" style={at(lineToGain)} />}
      {ball !== null && <span className={`dstrip-ball${track.ballSource === 'live' ? ' is-live' : ''}`} style={at(ball)} />}
    </>
  );
}

export interface DriveStripProps {
  game: GameSummary;
  entry: DetailState | undefined;
  situation: Situation | null;
  compact: boolean;
}

export const DriveStrip = memo(function DriveStrip({ game, entry, situation, compact }: DriveStripProps) {
  const dark = useIsDark();
  const detail = entry?.detail ?? null;
  const track = useMemo(() => (detail ? driveTrack(detail, { situation }) : null), [detail, situation]);
  const drawable = hasDrivePosition(track) ? track : null;
  const offense = drawable ? teamFor(game, drawable.offense) : null;
  const style = useMemo(
    () => ({ '--drive': accentFor(offense?.color ?? null, dark), '--ez-away': accentFor(game.away.color, dark), '--ez-home': accentFor(game.home.color, dark) }) as CSSProperties,
    [offense?.color, game.away.color, game.home.color, dark],
  );

  let name: string;
  if (game.coverage.level === 'score-only') name = 'Drive not reported';
  else if (!detail) name = entry?.freshness.health === 'unavailable' ? 'Drive unavailable' : 'Loading drive';
  else if (!drawable) name = 'Drive not reported';
  else if (drawable.inProgress) name = offense ? `${offense.abbreviation} drive` : 'Drive';
  else name = [offense?.abbreviation, driveOutcome(drawable) ?? 'Drive ended'].filter(Boolean).join(' · ');

  return (
    <div className={`dstrip${compact ? ' is-compact' : ''}${drawable ? '' : ' is-empty'}${drawable?.inProgress ? ' is-live' : ''}`} style={style}>
      {drawable && <span className="sr-only">{describeDrive(drawable, game)}</span>}
      {!compact && (
        <span className="dstrip-name mono" aria-hidden="true">
          {name}
        </span>
      )}
      <span className="dstrip-field" aria-hidden="true">
        <span className="dstrip-ez is-away" />
        <span className="dstrip-track">{drawable && <Marks track={drawable} />}</span>
        <span className="dstrip-ez is-home" />
      </span>
      {!compact && drawable && (
        <span className="dstrip-stat mono" aria-hidden="true">
          {driveStats(drawable).join(' · ')}
        </span>
      )}
    </div>
  );
});
