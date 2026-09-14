/** Game page panels: scoreboard, situation, catch-up, drives, scoring, stats and game information. */
import { ChevronDown, Star } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { describeProgress } from '../../../shared/field';
import { downDistance, spotLabel, teamFor } from '../../../shared/format';
import type { BallSpot, GameDetail, GameLeader, GameSummary, LeaderAthlete, Side, Situation } from '../../../shared/model';
import { DIVISION_LABEL, isLiveOrPaused } from '../../../shared/model';
import { driveResultLabel, inspectablePlays, type CatchUpSummary, type PlayFrame } from '../../../shared/replayFrames';
import { periodLong, periodShort } from '../../../shared/util';
import { primaryBroadcast } from '../../components/GameCard';
import { Score } from '../../components/Score';
import { StatusPill } from '../../components/StatusPill';
import { TeamLink } from '../../components/TeamLink';
import { TeamLogo } from '../../components/TeamLogo';
import { accentFor } from '../../field/color';
import { useIsDark } from '../../lib/theme';
import { kickoffShort } from '../../lib/time';
import { usePrefs } from '../../state/prefs';

const PROVENANCE: Record<BallSpot['provenance'], string> = {
  label: 'Provider field-position label',
  'yards-to-endzone': 'Provider distance to the end zone',
  'home-yardline': 'Provider yard line',
  unknown: 'Not reported',
};

function Timeouts({ remaining }: { remaining: number }) {
  return (
    <span className="timeouts" title={`${remaining} timeouts left`}>
      <span className="sr-only">{remaining} timeouts left</span>
      {[0, 1, 2].map((i) => (
        <span key={i} className={`timeout${i < remaining ? ' is-left' : ''}`} aria-hidden="true" />
      ))}
    </span>
  );
}

export function Scoreboard({ game, situation }: { game: GameSummary; situation: Situation | null }) {
  const favorites = usePrefs((s) => s.favorites);
  const dark = useIsDark();
  const live = isLiveOrPaused(game.status.kind);
  const possession = live ? (situation?.possession ?? null) : null;
  const broadcast = primaryBroadcast(game);
  // The status pill already names the clock or kickoff. Beneath it: where the offense stands while play is live.
  const down = game.status.kind === 'in_progress' && situation ? [downDistance(situation), situation.spot.schematicYard !== null ? spotLabel(situation.spot, game) : null].filter(Boolean).join(' · ') : '';

  const team = (side: Side) => {
    const t = game[side];
    const favorite = favorites.some((f) => f.key === t.key);
    const timeouts = live ? (situation?.timeouts[side] ?? null) : null;
    return (
      <div className={`sb-team sb-${side}${possession === side ? ' has-ball' : ''}`}>
        <TeamLogo team={t} size={56} />
        <div className="sb-name">
          <p className="sb-location">
            {t.rank !== null && <span className="team-rank mono">{t.rank}</span>}
            {t.location ?? t.abbreviation}
            <button
              type="button"
              className={`icon-btn icon-btn-sm sb-star${favorite ? ' is-starred' : ''}`}
              aria-pressed={favorite}
              aria-label={favorite ? `Remove ${t.displayName} from favorites` : `Add ${t.displayName} to favorites`}
              title={favorite ? 'Favorite team' : 'Add to favorites'}
              onClick={() => usePrefs.getState().toggleFavorite({ key: t.key, league: t.league, abbreviation: t.abbreviation, name: t.displayName, logo: t.logo, color: t.color })}
            >
              <Star size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </p>
          <p className="sb-team-name">
            <TeamLink teamKey={t.key} label={`${t.displayName} team page`}>
              {t.shortName}
            </TeamLink>
          </p>
          <p className="sb-record mono">
            {t.record ?? ''}
            {timeouts !== null && <Timeouts remaining={timeouts} />}
          </p>
        </div>
        <span className="sb-ball" aria-hidden="true" />
        <Score value={game.score[side]} className="sb-score" />
      </div>
    );
  };

  return (
    <section className="scoreboard" aria-label="Scoreboard" style={{ '--team-away': accentFor(game.away.color, dark), '--team-home': accentFor(game.home.color, dark) } as CSSProperties}>
      {team('away')}
      <div className="sb-center">
        <StatusPill game={game} />
        {down && <p className="sb-sub mono">{down}</p>}
        {broadcast && <p className="sb-sub">{broadcast}</p>}
      </div>
      {team('home')}
    </section>
  );
}

export function SituationPanel({ game, situation, lastKnown, frame }: { game: GameSummary; situation: Situation | null; lastKnown: boolean; frame: PlayFrame | null }) {
  const spot = situation?.spot ?? null;
  const known = !!spot && spot.schematicYard !== null;
  const offense = teamFor(game, situation?.possession ?? null);
  const live = isLiveOrPaused(game.status.kind);
  const heading = frame ? `Historical view · play ${frame.index + 1} of ${frame.total}` : lastKnown ? 'Last known situation' : live ? 'Situation' : 'Game state';

  return (
    <section className="panel situation-panel" aria-label="Situation">
      <p className="eyebrow">{heading}</p>
      {!frame && !live ? (
        <p className="sit-main">{game.status.kind === 'scheduled' ? `Kickoff ${kickoffShort(game.startTime)}` : 'No live situation'}</p>
      ) : !situation ? (
        <p className="sit-main">{game.coverage.level === 'score-only' ? 'Score-only coverage' : 'Situation not reported'}</p>
      ) : (
        <>
          <p className="sit-main">
            {offense ? `${offense.abbreviation} ball` : 'Possession not reported'}
            {downDistance(situation) && <span className="sit-dd"> · {downDistance(situation)}</span>}
          </p>
          <dl className="sit-grid">
            <div>
              <dt>Ball spot</dt>
              <dd>{spotLabel(spot, game)}</dd>
            </div>
            <div>
              <dt>Field position</dt>
              <dd>{known && spot?.progress !== null && spot?.progress !== undefined ? describeProgress(spot.progress) : 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Red zone</dt>
              <dd>{known && spot?.progress != null ? (spot.progress >= 80 ? 'Yes' : 'No') : 'Unknown'}</dd>
            </div>
            <div>
              <dt>Spot source</dt>
              <dd>{spot ? PROVENANCE[spot.provenance] : PROVENANCE.unknown}</dd>
            </div>
          </dl>
        </>
      )}
      {frame ? (
        <p className="sit-play">
          <span className="mono">{[periodShort(frame.play.period), frame.play.clock].filter(Boolean).join(' ')}</span> {frame.play.description}
        </p>
      ) : (
        situation?.lastPlay && <p className="sit-play">Last play: {situation.lastPlay.description}</p>
      )}
      <p className="sit-note">
        Schematic field: {game.away.abbreviation} defends the left end zone.{' '}
        {known && spot?.lateral != null ? 'The ball is drawn across the field at the lateral position in the data.' : 'The ball sits on the centre line because no lateral position is reported.'}
      </p>
    </section>
  );
}

export function CatchUpPanel({ summary, onSelect, sinceLabel }: { summary: CatchUpSummary; onSelect: (order: number) => void; sinceLabel: string }) {
  return (
    <section className="panel catchup" aria-label="Catch-up summary">
      <p className="eyebrow">{sinceLabel}</p>
      <p className="catchup-headline">{summary.headline}</p>
      {summary.items.length > 0 && (
        <ol className="catchup-list">
          {summary.items.slice(-6).map((item) => (
            <li key={item.order}>
              <button type="button" className={`catchup-item tone-${item.tone}`} onClick={() => onSelect(item.order)}>
                <span className="mono">{item.when}</span>
                <span>{item.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const LEADER_TITLE: Record<GameLeader['category'], string> = { passing: 'Passing', rushing: 'Rushing', receiving: 'Receiving' };
const LEADER_CATEGORIES: Array<GameLeader['category']> = ['passing', 'rushing', 'receiving'];

/** A smaller copy through the provider's image resizer on the same host, for a standard headshot URL. */
function resizedHeadshot(url: string): string | null {
  const match = /^https:\/\/a\.espncdn\.com(\/i\/headshots\/[\w/.-]+\.png)$/.exec(url);
  return match ? `https://a.espncdn.com/combiner/i?img=${match[1]}&w=120&h=87` : null;
}

function Headshot({ athlete }: { athlete: LeaderAthlete }) {
  const sources = useMemo(() => (athlete.headshot ? [resizedHeadshot(athlete.headshot), athlete.headshot].filter((s): s is string => !!s) : []), [athlete.headshot]);
  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];
  if (!src) {
    const initials = athlete.name
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();
    return (
      <span className="leader-photo is-fallback" aria-hidden="true">
        {initials}
      </span>
    );
  }
  return <img className="leader-photo" src={src} alt="" width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setAttempt((a) => a + 1)} />;
}

/** Passing, rushing and receiving leaders for each team, exactly as the provider reports them. */
export function LeadersPanel({ detail, game }: { detail: GameDetail; game: GameSummary }) {
  const dark = useIsDark();
  const categories = LEADER_CATEGORIES.filter((c) => detail.leaders.some((t) => t.leaders.some((l) => l.category === c)));
  if (!categories.length) return null;
  return (
    <section className="panel leaders" aria-label="Game leaders">
      <p className="eyebrow">{game.status.kind === 'final' ? 'Game leaders' : 'Leaders so far'}</p>
      {categories.map((category) => (
        <div key={category} className="leaders-group">
          <p className="leaders-cat">{LEADER_TITLE[category]}</p>
          <ul className="leaders-list">
            {(['away', 'home'] as const).map((side) => {
              const leader = detail.leaders.find((t) => t.side === side)?.leaders.find((l) => l.category === category);
              if (!leader) return null;
              const team = game[side];
              return (
                <li key={side} className="leader" style={{ '--team': accentFor(team.color, dark) } as CSSProperties}>
                  <Headshot key={leader.athlete.headshot ?? leader.athlete.name} athlete={leader.athlete} />
                  <span className="leader-main">
                    <span className="leader-name">
                      {leader.athlete.name}
                      <span className="leader-meta mono"> {[team.abbreviation, leader.athlete.position].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="leader-line mono">{leader.line}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function DriveBar({ start, end }: { start: number | null; end: number | null }) {
  if (start === null) return <span className="drive-bar is-empty" aria-hidden="true" />;
  const a = Math.min(start, end ?? start);
  const b = Math.max(start, end ?? start);
  return (
    <svg className="drive-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="4" width="100" height="2" rx="1" className="drive-track" />
      <rect x={a} y="2.5" width={Math.max(1.2, b - a)} height="5" rx="2.5" className="drive-span" />
      <circle cx={end ?? start} cy="5" r="2.6" className="drive-end" />
    </svg>
  );
}

export function DriveExplorer({ detail, game, onReplayDrive, onSelectPlay, activeDriveId }: { detail: GameDetail; game: GameSummary; onReplayDrive: (driveId: string) => void; onSelectPlay: (order: number, driveId: string) => void; activeDriveId: string | null }) {
  const [expanded, setExpanded] = useState<string | null>(detail.currentDriveId);
  const drives = useMemo(() => [...detail.drives].reverse(), [detail.drives]);
  if (!drives.length) return <p className="empty-note">No drives reported yet{game.coverage.level === 'score-only' ? ': this game has score-only coverage' : ''}.</p>;
  return (
    <ol className="drives">
      {drives.map((d) => {
        const team = teamFor(game, d.offense);
        const plays = inspectablePlays(detail, d.id);
        const start = d.start?.spot.schematicYard ?? plays[0]?.start?.spot.schematicYard ?? null;
        const end = d.end?.spot.schematicYard ?? plays[plays.length - 1]?.end?.spot.schematicYard ?? null;
        const result = driveResultLabel(d.result) ?? (d.isCurrent ? 'In progress' : 'Result not reported');
        const meta = [
          [periodShort(d.start?.period ?? null), d.start?.clock].filter(Boolean).join(' '),
          d.start?.label ? `from ${d.start.label}` : null,
          `${d.offensivePlays ?? plays.length} plays`,
          d.yards !== null ? `${d.yards} yards` : null,
          d.timeElapsed,
        ].filter(Boolean);
        const open = expanded === d.id;
        return (
          <li key={d.id} className={`drive${d.isCurrent ? ' is-current' : ''}${activeDriveId === d.id ? ' is-active' : ''}`}>
            <div className="drive-head">
              {team ? <TeamLogo team={team} size={26} /> : <span className="logo-fallback" style={{ width: 26, height: 26 }} aria-hidden="true" />}
              <div className="drive-main">
                <p className="drive-title">
                  <span>{team?.abbreviation ?? 'Unknown team'}</span> · <span className={d.isScore ? 'is-score' : ''}>{result}</span>
                </p>
                <p className="drive-meta mono">{meta.join(' · ')}</p>
              </div>
              <DriveBar start={start} end={end} />
              <button type="button" className="btn btn-ghost btn-sm" disabled={!plays.length} onClick={() => onReplayDrive(d.id)}>
                Replay
              </button>
              <button type="button" className="icon-btn" aria-expanded={open} aria-label={open ? 'Hide plays' : 'Show plays'} onClick={() => setExpanded(open ? null : d.id)}>
                <ChevronDown size={16} className={open ? 'is-flipped' : ''} aria-hidden="true" />
              </button>
            </div>
            {open && (
              <ol className="drive-plays">
                {plays.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="drive-play" onClick={() => onSelectPlay(p.order, d.id)}>
                      <span className="mono">{p.start?.downDistanceText ?? downDistance(p.start) ?? ''}</span>
                      <span>{p.description}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const SCORE_KIND: Record<string, string> = { touchdown: 'Touchdown', field_goal: 'Field goal', safety: 'Safety', conversion: 'Conversion', unknown: 'Score' };

export function ScoringTimeline({ detail, game, onSelectPlay }: { detail: GameDetail; game: GameSummary; onSelectPlay: (order: number) => void }) {
  if (!detail.scoring.length) return <p className="empty-note">No scoring plays reported yet.</p>;
  let lastPeriod: number | null = -1;
  return (
    <ol className="timeline">
      {detail.scoring.map((s) => {
        const team = teamFor(game, s.team);
        const order = s.playId ? (detail.plays.find((p) => p.id === s.playId)?.order ?? null) : null;
        const header = s.period !== lastPeriod ? <li key={`p${s.period}`} className="timeline-period eyebrow">{periodLong(s.period) ?? 'Period not reported'}</li> : null;
        lastPeriod = s.period;
        return [
          header,
          <li key={s.id} className={`timeline-item side-${s.team ?? 'unknown'}`}>
            <span className="timeline-when mono">{s.clock ?? ''}</span>
            <span className="timeline-team">
              {team && <TeamLogo team={team} size={22} />}
              <span>{team?.abbreviation ?? ''}</span>
            </span>
            <span className="timeline-body">
              <span className="timeline-kind">{SCORE_KIND[s.kind] ?? 'Score'}</span>
              <span className="timeline-desc">{s.description}</span>
            </span>
            <span className="timeline-score mono">
              {game.away.abbreviation} {s.scoreAfter.away ?? ''} · {game.home.abbreviation} {s.scoreAfter.home ?? ''}
            </span>
            {order !== null && (
              <button type="button" className="link-btn" onClick={() => onSelectPlay(order)}>
                View play
              </button>
            )}
          </li>,
        ];
      })}
    </ol>
  );
}

export function StatsTable({ detail, game }: { detail: GameDetail; game: GameSummary }) {
  if (!detail.stats.length) return <p className="empty-note">Team stats are not reported yet{game.coverage.teamStats ? '' : ' for this game'}.</p>;
  return (
    <div className="table-wrap">
      <table className="stats">
        <caption className="sr-only">Team statistics</caption>
        <thead>
          <tr>
            <th scope="col">Stat</th>
            <th scope="col">{game.away.abbreviation}</th>
            <th scope="col">{game.home.abbreviation}</th>
          </tr>
        </thead>
        <tbody>
          {detail.stats.map((s) => (
            <tr key={s.key}>
              <th scope="row">{s.label}</th>
              <td className="mono">{s.away ?? '·'}</td>
              <td className="mono">{s.home ?? '·'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GameInfo({ game, detail }: { game: GameSummary; detail: GameDetail | null }) {
  const venue = game.venue ? [game.venue.name, [game.venue.city, game.venue.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : null;
  return (
    <dl className="info-grid">
      <div>
        <dt>Kickoff</dt>
        <dd>{game.startTime ? new Date(game.startTime).toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not reported'}</dd>
      </div>
      <div>
        <dt>Broadcast</dt>
        <dd>{game.broadcasts.length ? game.broadcasts.map((b) => `${b.name}${b.medium !== 'unknown' ? ` (${b.medium === 'tv' ? 'TV' : b.medium})` : ''}`).join(', ') : 'Not reported'}</dd>
      </div>
      <div>
        <dt>Venue</dt>
        <dd>{venue ?? 'Not reported'}{game.neutralSite ? ' · neutral site' : ''}</dd>
      </div>
      {detail?.attendance != null && (
        <div>
          <dt>Attendance</dt>
          <dd>{detail.attendance.toLocaleString()}</dd>
        </div>
      )}
      <div>
        <dt>Competition</dt>
        <dd>
          {game.league === 'nfl' ? 'NFL' : game.divisions.map((d) => DIVISION_LABEL[d]).join(', ') || 'College'}
          {game.season.week !== null ? ` · week ${game.season.week}` : ''}
          {game.conferenceGame ? ' · conference game' : ''}
        </dd>
      </div>
      <div>
        <dt>Coverage</dt>
        <dd>{game.coverage.level === 'full' ? 'Play-by-play reported' : game.coverage.level === 'score-only' ? 'Score only: no play-by-play from the provider' : 'Not known until kickoff'}</dd>
      </div>
      {game.notes.length > 0 && (
        <div>
          <dt>Notes</dt>
          <dd>{game.notes.join(' · ')}</dd>
        </div>
      )}
      <div>
        <dt>Source</dt>
        <dd>
          {game.coverage.provider}
          {game.links.gamePage && (
            <>
              {' · '}
              <a href={game.links.gamePage} target="_blank" rel="noopener noreferrer">
                Provider game page
              </a>
            </>
          )}
          <span className="muted"> · Gridiron does not stream video or link to streams.</span>
        </dd>
      </div>
    </dl>
  );
}
