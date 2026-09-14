/**
 * A team page: a holographic team hero, the season as a timeline of results
 * and upcoming games, scoring margins and the full schedule, all from the
 * provider's team and schedule documents. In the replay lab, games after the
 * replay clock show as not yet played, and the season record, rank and
 * standing, which the provider reports only as of today, are hidden.
 */
import { Share2, Star } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import type { GameSummary, LeagueId, Team } from '../../shared/model';
import { isLiveOrPaused } from '../../shared/model';
import type { ScheduleGame, ScheduleOpponent, TeamPage, TeamProfile } from '../../shared/team';
import { isTeamPageId, linkClick, navigate, pathFor, useLocation, type Route } from '../app/router';
import { IconButton } from '../components/controls';
import { TeamLink } from '../components/TeamLink';
import { TeamLogo } from '../components/TeamLogo';
import { getJson } from '../data/api';
import { accentFor } from '../field/color';
import { shareLink } from '../lib/share';
import { useIsDark } from '../lib/theme';
import { useLive, usePresentedWorld } from '../state/live';
import { usePrefs } from '../state/prefs';
import { bestSummary } from '../state/selectors';
import { useUi } from '../state/ui';
import { TeamBack, TeamHeroLoading } from './TeamLoading';

interface TeamResponse {
  page: TeamPage;
  source: 'live' | 'saved';
  asOf: string | null;
}

type LoadState = { status: 'loading' } | { status: 'ready'; data: TeamResponse } | { status: 'error'; message: string };

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
// A kickoff without a set time carries a midnight Eastern placeholder, so its day is read in Eastern time.
const DAY_EASTERN = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const STAMP = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function asTeam(p: TeamProfile): Team {
  return { key: p.key, league: p.league, providerId: p.providerId, abbreviation: p.abbreviation, displayName: p.displayName, shortName: p.shortName, location: p.location, color: p.color, alternateColor: p.alternateColor, logo: p.logo, logoDark: p.logoDark, rank: p.rank, record: p.record.total, conferenceId: null };
}

function opponentTeam(o: ScheduleOpponent, league: LeagueId): Team {
  return { key: o.key, league, providerId: o.providerId, abbreviation: o.abbreviation, displayName: o.displayName, shortName: o.shortName, location: null, color: null, alternateColor: null, logo: o.logo, logoDark: null, rank: o.rank, record: null, conferenceId: null };
}

function when(g: ScheduleGame, short = false): string {
  const d = new Date(g.date);
  if (!Number.isFinite(d.getTime())) return 'Date not reported';
  if (!g.timeValid) return short ? DAY_EASTERN.format(d) : `${DAY_EASTERN.format(d)} · time TBD`;
  return short ? DAY.format(d) : `${DAY.format(d)} · ${TIME.format(d)}`;
}

function weekLabel(g: ScheduleGame): string {
  if (g.seasonType === 2 && g.week.number !== null) return `W${g.week.number}`;
  return g.week.text ?? (g.seasonType === 3 ? 'Post' : g.seasonType === 1 ? 'Pre' : '');
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const streakText = (n: number | null) => (n === null || n === 0 ? null : n > 0 ? `W${n}` : `L${-n}`);

/** The score from this team's side: the presented live summary when the game is on the board, otherwise the schedule's. */
function scoreFor(g: ScheduleGame, live: GameSummary | null): { team: number; opponent: number } | null {
  if (live && isLiveOrPaused(live.status.kind) && live.score.home !== null && live.score.away !== null) {
    const home = g.homeAway === 'home';
    return { team: home ? live.score.home : live.score.away, opponent: home ? live.score.away : live.score.home };
  }
  return g.score;
}

function outcome(g: ScheduleGame, live: GameSummary | null): { text: string; tone: 'win' | 'loss' | 'tie' | 'live' | 'pre' | 'other' } {
  const score = scoreFor(g, live);
  if ((live && isLiveOrPaused(live.status.kind)) || g.status.state === 'in') return { text: score ? `Live ${score.team}-${score.opponent}` : 'Live', tone: 'live' };
  if (g.status.completed && score) {
    const ot = /OT/.test(g.status.shortDetail ?? '') ? ' OT' : '';
    const tone = g.result === 'W' ? 'win' : g.result === 'L' ? 'loss' : g.result === 'T' ? 'tie' : 'other';
    return { text: `${g.result ?? ''} ${score.team}-${score.opponent}${ot}`.trim(), tone };
  }
  if (g.status.state === 'post') return { text: g.status.shortDetail ?? 'Not played', tone: 'other' };
  if (g.status.state === 'unknown') return { text: g.status.shortDetail ?? 'Status not reported', tone: 'other' };
  return { text: when(g, true), tone: 'pre' };
}

type SeasonItem = { kind: 'game'; game: ScheduleGame } | { kind: 'bye'; week: number };

function seasonItems(page: TeamPage): SeasonItem[] {
  const byes = [...page.byeWeeks].sort((a, b) => a - b);
  const items: SeasonItem[] = [];
  for (const game of page.schedule) {
    while (byes.length && game.seasonType === 2 && game.week.number !== null && byes[0] < game.week.number) items.push({ kind: 'bye', week: byes.shift()! });
    items.push({ kind: 'game', game });
  }
  return items;
}

function GameGlance({ title, game, league, live }: { title: string; game: ScheduleGame; league: LeagueId; live: GameSummary | null }) {
  const opponent = opponentTeam(game.opponent, league);
  const result = outcome(game, live);
  const route: Route = { name: 'game', id: game.gameId };
  return (
    <section className={`panel glance tone-${result.tone}`} aria-label={title}>
      <p className="eyebrow">{title}</p>
      <div className="glance-row">
        <TeamLogo team={opponent} size={40} />
        <div className="glance-main">
          <p className="glance-opp">
            {game.homeAway === 'away' ? 'at' : 'vs'} <TeamLink teamKey={opponent.key}>{game.opponent.displayName}</TeamLink>
          </p>
          <p className="glance-meta">{[when(game), game.venue].filter(Boolean).join(' · ')}</p>
          {game.broadcasts.length > 0 && <p className="glance-meta mono">{game.broadcasts.join(', ')}</p>}
        </div>
        <p className={`glance-result mono tone-${result.tone}`}>{result.tone === 'pre' ? null : result.text}</p>
      </div>
      <a className="btn btn-ghost btn-sm glance-open" href={pathFor(route)} onClick={linkClick(route)}>
        Open game
      </a>
    </section>
  );
}

export function TeamView({ id }: { id: string }) {
  const valid = isTeamPageId(id);
  const { params } = useLocation();
  const source = useLive((s) => s.source);
  const world = usePresentedWorld();
  const dark = useIsDark();
  const favorites = usePrefs((s) => s.favorites);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  // A replay link must never fetch the live page first, so wait until the replay session is connected.
  const waitingForReplay = !!params.get('replay') && source.kind !== 'replay';
  const base = source.kind === 'live' ? '/api' : `/api/replay/s/${source.sessionId}`;

  useEffect(() => {
    if (!valid || waitingForReplay) return;
    let cancelled = false;
    getJson<TeamResponse>(`${base}/team/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((e: Error) => {
        if (!cancelled) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: e.message }));
      });
    return () => {
      cancelled = true;
    };
  }, [base, id, valid, waitingForReplay, refresh]);

  const page = state.status === 'ready' ? state.data.page : null;
  const replay = state.status === 'ready' && state.data.asOf !== null;
  const hasLive = !!page?.schedule.some((g) => g.status.state === 'in');
  const ready = state.status === 'ready';
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => setRefresh((n) => n + 1), replay ? 30_000 : hasLive ? 60_000 : 5 * 60_000);
    return () => clearInterval(timer);
  }, [ready, replay, hasLive]);

  useEffect(() => {
    if (page) document.title = `${page.team.displayName} · Gridiron`;
  }, [page]);

  const back = <TeamBack />;

  if (!valid) {
    return (
      <div className="state-block">
        <p className="eyebrow">Team</p>
        <h1 className="state-title">That team link is not valid.</h1>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'slate' })}>
          Go to the slate
        </button>
      </div>
    );
  }

  if (state.status !== 'ready') {
    return (
      <div className="team" aria-busy={state.status === 'loading'}>
        <div className="team-top">{back}</div>
        {state.status === 'loading' ? (
          <TeamHeroLoading />
        ) : (
          <div className="state-block">
            <p className="eyebrow">Team</p>
            <h1 className="state-title">This team page could not be loaded.</h1>
            <p className="muted">{state.message}</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRefresh((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const { page: data, source: origin, asOf } = state.data;
  const team = asTeam(data.team);
  const favorite = favorites.some((f) => f.key === team.key);
  const stats = data.team.stats;
  const record = data.team.record;
  const liveOf = (g: ScheduleGame) => bestSummary(world, g.gameId);
  const items = seasonItems(data);
  const completed = data.schedule.filter((g) => g.status.completed && g.score);
  const maxMargin = Math.max(7, ...completed.map((g) => Math.abs(g.score!.team - g.score!.opponent)));
  const current = data.schedule.find((g) => g.status.state === 'in') ?? null;
  const next = data.schedule.find((g) => g.status.state === 'pre') ?? null;
  const last = completed[completed.length - 1] ?? null;
  const nextId = next?.gameId ?? null;
  const league = team.league === 'nfl' ? 'NFL' : 'College football';
  const style = { '--team': accentFor(team.color, dark), '--team-2': accentFor(team.alternateColor, dark) } as CSSProperties;

  const share = async () => {
    const result = await shareLink(window.location.href, document.title);
    useUi.getState().showNotice(result === 'failed' ? 'Could not copy the link' : result === 'copied' ? 'Link copied' : 'Link shared');
  };

  return (
    <article className="team" aria-labelledby="team-title" style={style}>
      <div className="team-top">{back}</div>

      <header className="team-hero">
        <div className="team-holo" aria-hidden="true">
          <div className="team-holo-floor">
            <span className="team-floor-grid" />
            <span className="team-ring r1" />
            <span className="team-ring r2" />
            <span className="team-ring r3" />
          </div>
          <span className="team-beam" />
          <span className="team-shadow" />
          <span className="team-emblem">
            <TeamLogo team={team} size={132} />
          </span>
        </div>
        <div className="team-id">
          <p className="eyebrow">{[league, !replay ? data.team.standingSummary : null].filter(Boolean).join(' · ')}</p>
          <h1 id="team-title" className="team-title">
            {team.rank !== null && !replay && <span className="team-rank mono">{team.rank}</span>}
            {team.displayName}
          </h1>
          <p className="team-sub mono">
            {team.abbreviation} · {data.season.year} {data.season.label}
          </p>
          {replay ? (
            <p className="team-replay-note">Season record, rank and standing are hidden in the replay lab: the provider reports them only as of today.</p>
          ) : (
            <dl className="team-stats">
              <div>
                <dt>Record</dt>
                <dd>{record.total ?? 'Not reported'}</dd>
              </div>
              {record.home && (
                <div>
                  <dt>Home</dt>
                  <dd>{record.home}</dd>
                </div>
              )}
              {record.road && (
                <div>
                  <dt>Road</dt>
                  <dd>{record.road}</dd>
                </div>
              )}
              {streakText(stats.streak) && (
                <div>
                  <dt>Streak</dt>
                  <dd>{streakText(stats.streak)}</dd>
                </div>
              )}
              {stats.pointsFor !== null && stats.pointsAgainst !== null && (
                <div>
                  <dt>Points</dt>
                  <dd>
                    {stats.pointsFor}-{stats.pointsAgainst}
                  </dd>
                </div>
              )}
              {stats.pointDifferential !== null && (
                <div>
                  <dt>Differential</dt>
                  <dd>{signed(stats.pointDifferential)}</dd>
                </div>
              )}
            </dl>
          )}
          <div className="team-actions">
            <button
              type="button"
              className={`btn btn-sm ${favorite ? 'btn-primary' : 'btn-ghost'}`}
              aria-pressed={favorite}
              onClick={() => usePrefs.getState().toggleFavorite({ key: team.key, league: team.league, abbreviation: team.abbreviation, name: team.displayName, logo: team.logo, color: team.color })}
            >
              <Star size={14} aria-hidden="true" /> {favorite ? 'Favorite team' : 'Add to favorites'}
            </button>
            <IconButton label="Share a link to this team" icon={Share2} onClick={() => void share()} />
          </div>
        </div>
      </header>

      {(current || next || last) && (
        <div className="team-glance">
          {current && <GameGlance title="Live now" game={current} league={team.league} live={liveOf(current)} />}
          {!current && next && <GameGlance title="Next game" game={next} league={team.league} live={null} />}
          {last && <GameGlance title="Last result" game={last} league={team.league} live={null} />}
        </div>
      )}

      <section className="panel team-season" aria-labelledby="team-season-title">
        <div className="section-head">
          <h2 id="team-season-title">Season</h2>
        </div>
        {items.length ? (
          <ol className="season-rail">
            {items.map((item) => {
              if (item.kind === 'bye') {
                return (
                  <li key={`bye-${item.week}`}>
                    <span className="season-node is-bye">
                      <span className="sn-week mono">W{item.week}</span>
                      <span className="sn-dot" aria-hidden="true" />
                      <span className="sn-bye">Bye week</span>
                    </span>
                  </li>
                );
              }
              const g = item.game;
              const opponent = opponentTeam(g.opponent, team.league);
              const result = outcome(g, liveOf(g));
              const route: Route = { name: 'game', id: g.gameId };
              return (
                <li key={g.gameId}>
                  <a className={`season-node is-${result.tone}${g.gameId === nextId ? ' is-next' : ''}`} href={pathFor(route)} onClick={linkClick(route)} aria-label={`${weekLabel(g)}: ${g.homeAway === 'away' ? 'at' : 'versus'} ${g.opponent.displayName}, ${result.text}`}>
                    <span className="sn-week mono">{weekLabel(g)}</span>
                    <span className="sn-dot" aria-hidden="true" />
                    <TeamLogo team={opponent} size={30} />
                    <span className="sn-opp">
                      {g.homeAway === 'away' ? '@' : 'vs'} {g.opponent.abbreviation}
                    </span>
                    <span className="sn-out mono">{result.text}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="empty-note">No games reported for this season.</p>
        )}
      </section>

      {completed.length > 0 && (
        <section className="panel team-margins" aria-labelledby="team-margin-title">
          <div className="section-head">
            <h2 id="team-margin-title">Scoring margin</h2>
          </div>
          <div className="margin-plot" role="img" aria-label={`Scoring margin by game: ${completed.map((g) => `${weekLabel(g)} ${signed(g.score!.team - g.score!.opponent)}`).join(', ')}`}>
            {completed.map((g) => {
              const margin = g.score!.team - g.score!.opponent;
              return (
                <div key={g.gameId} className={`margin-col ${margin > 0 ? 'is-win' : margin < 0 ? 'is-loss' : 'is-tie'}`} style={{ '--m': Math.abs(margin) / maxMargin } as CSSProperties} aria-hidden="true">
                  <span className="margin-bar" />
                  <span className="margin-val mono">{signed(margin)}</span>
                  <span className="margin-wk mono">{weekLabel(g)}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="panel team-schedule" aria-labelledby="team-schedule-title">
        <div className="section-head">
          <h2 id="team-schedule-title">Schedule</h2>
        </div>
        <div className="table-scroll">
          <table className="schedule-table">
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col">Date</th>
                <th scope="col">Opponent</th>
                <th scope="col">Result</th>
                <th scope="col">Broadcast</th>
              </tr>
            </thead>
            <tbody>
              {data.schedule.map((g) => {
                const opponent = opponentTeam(g.opponent, team.league);
                const result = outcome(g, liveOf(g));
                const route: Route = { name: 'game', id: g.gameId };
                return (
                  <tr key={g.gameId} className={result.tone === 'live' ? 'is-live' : ''}>
                    <td className="mono">{weekLabel(g)}</td>
                    <td>{when(g)}</td>
                    <td>
                      <span className="sched-opp">
                        <TeamLogo team={opponent} size={22} />
                        <span>{g.homeAway === 'away' ? 'at' : 'vs'}</span>
                        <TeamLink teamKey={opponent.key}>{g.opponent.displayName}</TeamLink>
                        {g.neutralSite && <span className="tag">Neutral site</span>}
                      </span>
                    </td>
                    <td>
                      <a className={`sched-result mono tone-${result.tone}`} href={pathFor(route)} onClick={linkClick(route)}>
                        {result.tone === 'pre' ? 'Preview' : result.text}
                      </a>
                    </td>
                    <td className="muted">{g.broadcasts.join(', ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <p className="team-source">
        Team and schedule from ESPN{origin === 'saved' ? ' saved documents' : ''}, received {STAMP.format(new Date(data.fetchedAt))}.
        {asOf ? ` Shown as of the replay clock, ${STAMP.format(new Date(asOf))}.` : ''} Bye weeks are gaps in the reported week numbers.
      </p>
    </article>
  );
}
