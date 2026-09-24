/**
 * The game page's drive chart. Every reported play of the current drive, or of
 * the drive being replayed, is an arrow across a 100-yard field, with the
 * drive's start, the line to gain and the ball. Spots come from the provider
 * only: a play without one keeps its row and says so.
 */
import type { CSSProperties } from 'react';
import { describeDrive, driveOutcome, driveStats, type DriveTrack, type DriveTrackPlay } from '../../../shared/driveTrack';
import { downDistance, teamFor } from '../../../shared/format';
import type { GameSummary, PlayKind, Situation } from '../../../shared/model';
import { isLiveOrPaused } from '../../../shared/model';
import type { PlayFrame } from '../../../shared/replayFrames';
import { periodShort } from '../../../shared/util';
import { TeamLogo } from '../../components/TeamLogo';
import { accentFor } from '../../field/color';
import { useIsDark } from '../../lib/theme';

const SCALE = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const clamp = (yard: number) => Math.min(100, Math.max(0, yard));

const SHORT: Partial<Record<PlayKind, string>> = {
  touchdown_rush: 'TD',
  touchdown_pass: 'TD',
  touchdown_return: 'TD',
  field_goal_good: 'FG',
  field_goal_missed: 'Miss',
  field_goal_blocked: 'Blk',
  extra_point: 'XP',
  two_point: '2pt',
  safety: 'Saf',
  interception: 'Int',
  fumble_lost: 'Fum',
  kickoff: 'KO',
  kickoff_return: 'KO',
  punt: 'Punt',
  punt_return: 'Punt',
  punt_blocked: 'Blk',
  penalty: 'Pen',
};

function outcome(p: DriveTrackPlay): string {
  if ((p.tone === 'gain' || p.tone === 'loss' || p.tone === 'even' || p.tone === 'penalty') && p.gain !== null) return p.gain > 0 ? `+${p.gain}` : String(p.gain);
  if (p.tone === 'turnover') return SHORT[p.kind] ?? 'TO';
  if (p.tone === 'score' || p.tone === 'conceded') return SHORT[p.kind] ?? 'Pts';
  return SHORT[p.kind] ?? '';
}

function rowLabel(p: DriveTrackPlay, regulationPeriods: number): string {
  const when = [periodShort(p.period, regulationPeriods), p.clock].filter(Boolean).join(' ');
  const text = p.description.trim().replace(/\.?$/, '.');
  return `${[when, p.downDistance].filter(Boolean).join(', ')}: ${text}${p.from === null && p.to === null ? ' Ball spot not reported.' : ''}`;
}

function Bar({ p }: { p: DriveTrackPlay }) {
  if (p.from === null && p.to === null) return <span className="dchart-nospot">Spot not reported</span>;
  if (p.from === null || p.to === null) {
    const x = clamp(p.to !== null ? p.to : (p.from as number));
    return <span className="dchart-dot is-partial" style={{ left: `${x}%` }} />;
  }
  const a = clamp(Math.min(p.from, p.to));
  const b = clamp(Math.max(p.from, p.to));
  if (b - a < 0.6) return <span className="dchart-dot" style={{ left: `${a}%` }} />;
  return <span className={`dchart-bar ${p.to >= p.from ? 'is-right' : 'is-left'}`} style={{ left: `${a}%`, width: `${b - a}%` }} />;
}

export interface DriveChartProps {
  /** Built once by the view, because the field draws the same drive. */
  track: DriveTrack | null;
  game: GameSummary;
  situation: Situation | null;
  frame: PlayFrame | null;
  onSelectPlay: (order: number, driveId: string) => void;
}

export function DriveChart({ track, game, situation, frame, onSelectPlay }: DriveChartProps) {
  const dark = useIsDark();
  const live = isLiveOrPaused(game.status.kind);
  const team = track ? teamFor(game, track.offense) : null;
  const heading = frame ? 'Drive at this play' : track && !track.inProgress ? (live ? 'Last drive' : 'Final drive') : 'Current drive';

  if (!track) {
    if (!live && !frame) return null;
    return (
      <section className="panel dchart" aria-label={heading}>
        <p className="eyebrow">{heading}</p>
        <p className="dchart-empty">{frame ? 'This play is not part of a reported drive.' : 'Drive not reported yet.'}</p>
      </section>
    );
  }

  const style = { '--drive': accentFor(team?.color ?? null, dark), '--ez-away': accentFor(game.away.color, dark), '--ez-home': accentFor(game.home.color, dark) } as CSSProperties;
  const now = !frame && track.inProgress && track.ballSource === 'live' && situation ? downDistance(situation) : null;
  const state = track.inProgress ? (frame ? 'At this play' : live ? 'In progress' : 'Result not reported') : (driveOutcome(track) ?? 'Result not reported');
  const stats = [...driveStats(track), track.startLabel ? `from ${track.startLabel}` : null].filter(Boolean);
  const pulsing = !frame && live && track.inProgress;

  return (
    <section className={`panel dchart${pulsing ? ' is-live' : ''}`} aria-label={heading} style={style}>
      <p className="eyebrow">{heading}</p>
      <div className="dchart-title">
        {team ? <TeamLogo team={team} size={26} /> : <span className="logo-fallback" style={{ width: 26, height: 26 }} aria-hidden="true" />}
        <span className="dchart-team">{team?.abbreviation ?? 'Offense not reported'}</span>
        <span className={`dchart-state${track.isScore ? ' is-score' : ''}${pulsing ? ' is-live' : ''}`}>{state}</span>
      </div>
      <p className="dchart-stats mono">{stats.join(' · ')}</p>
      <p className="sr-only">{describeDrive(track, game)}</p>

      <div className="dchart-scale mono" aria-hidden="true">
        <span className="dchart-scale-lane">
          {SCALE.map((yard) => (
            <span key={yard} style={{ left: `${yard}%` }}>
              {yard === 0 || yard === 100 ? 'G' : yard <= 50 ? yard : 100 - yard}
            </span>
          ))}
        </span>
      </div>
      <div className="dchart-plot">
        <span className="dchart-lane" aria-hidden="true">
          <span className="dchart-ez is-away" />
          <span className="dchart-ez is-home" />
          {track.start !== null && <span className="dchart-line is-start" style={{ left: `${clamp(track.start)}%` }} />}
          {track.lineToGain !== null && <span className="dchart-line is-ltg" style={{ left: `${clamp(track.lineToGain)}%` }} />}
          {track.ball !== null && <span className="dchart-line is-ball" style={{ left: `${clamp(track.ball)}%` }} />}
        </span>
        <ol className="dchart-rows">
          {track.plays.map((p) => {
            const selected = frame?.play.id === p.id;
            return (
              <li key={p.id}>
                <button type="button" className={`dchart-row tone-${p.tone}${selected ? ' is-selected' : ''}`} aria-label={rowLabel(p, game.status.regulationPeriods)} aria-current={selected ? 'step' : undefined} onClick={() => onSelectPlay(p.order, track.driveId)}>
                  <span className="dchart-dd mono" aria-hidden="true">
                    {p.downDistance ?? SHORT[p.kind] ?? ''}
                  </span>
                  <span className="dchart-cell" aria-hidden="true">
                    <Bar p={p} />
                  </span>
                  <span className="dchart-out mono" aria-hidden="true">
                    {outcome(p)}
                  </span>
                </button>
              </li>
            );
          })}
          {now && track.ball !== null && (
            <li className="dchart-now">
              <span className="sr-only">Next snap: {now}</span>
              <span className="dchart-dd mono" aria-hidden="true">
                {now}
              </span>
              <span className="dchart-cell" aria-hidden="true">
                <span className="dchart-pulse" style={{ left: `${clamp(track.ball)}%` }} />
              </span>
              <span className="dchart-out mono" aria-hidden="true">
                Now
              </span>
            </li>
          )}
        </ol>
      </div>
      {!track.plays.length && <p className="dchart-empty">No plays reported in this drive yet.</p>}
      <p className="dchart-legend" aria-hidden="true">
        {track.start !== null && <span className="dchart-key is-start">Drive start</span>}
        {track.lineToGain !== null && <span className="dchart-key is-ltg">Line to gain</span>}
        {track.ball !== null && <span className="dchart-key is-ball">{track.ballSource === 'live' ? 'Ball' : 'Last reported spot'}</span>}
      </p>
      <p className="dchart-note">
        Drawn from reported ball spots{track.unspotted ? `; ${track.unspotted} ${track.unspotted === 1 ? 'play has' : 'plays have'} no reported spot` : ''}. {game.away.abbreviation} defends the left end zone.
      </p>
    </section>
  );
}
