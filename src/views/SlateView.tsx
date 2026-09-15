/** The slate: live games first, then upcoming and final, with an honest empty day. */
import { FlaskConical, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { leagueNames, unknownLeagues } from '../../shared/availability';
import { statusShort } from '../../shared/format';
import type { GameSummary, LeagueId } from '../../shared/model';
import { LEAGUES } from '../../shared/model';
import { dateKeyToLabel } from '../../shared/util';
import { navigate } from '../app/router';
import { DigestPanel } from '../components/DigestPanel';
import { GameCard } from '../components/GameCard';
import { SummaryStrip } from '../components/SummaryStrip';
import { useNow } from '../lib/motion';
import { formatAgo, kickoffShort } from '../lib/time';
import { useSlateModel, type SlateModel } from '../state/hooks';
import { useLive } from '../state/live';
import { useLookaround } from '../state/lookaround';
import { DEFAULT_FILTERS, usePrefs } from '../state/prefs';
import type { SlateSection } from '../state/selectors';
import { useUi } from '../state/ui';

const SECTION_TITLES: Record<SlateSection, string> = {
  live: 'Live now',
  upcoming: 'Up next',
  final: 'Final',
  other: 'Postponed, canceled or unconfirmed',
};

export function GameGrid({ games, model, variant }: { games: GameSummary[]; model: SlateModel; variant: 'card' | 'compact' }) {
  return (
    <div className={`card-grid grid-${variant}`}>
      {games.map((g) => (
        <GameCard key={g.id} game={g} detail={model.world.details[g.id]} variant={variant} stale={model.stale.has(g.id)} afterGap={model.world.afterGap} watch={model.watchById.get(g.id) ?? null} />
      ))}
    </div>
  );
}

export function ProviderNotices({ model }: { model: SlateModel }) {
  const league = usePrefs((s) => s.league);
  const now = useNow(5000);
  const leagues: LeagueId[] = league === 'all' ? ['nfl', 'cfb'] : [league];
  const notices = leagues.map((l) => ({ l, f: model.world.freshness[l] })).filter(({ f }) => f.health === 'stale' || f.health === 'unavailable');
  if (!notices.length) return null;
  return (
    <div className="notices">
      {notices.map(({ l, f }) => (
        <section key={l} className={`banner ${f.health === 'unavailable' ? 'banner-danger' : 'banner-attention'}`} role="status">
          <TriangleAlert size={16} aria-hidden="true" />
          <p>
            <strong>
              {LEAGUES[l].shortName} {f.health === 'unavailable' ? 'data unavailable.' : 'updates delayed.'}
            </strong>{' '}
            {f.lastSuccessAt ? `Last successful update ${formatAgo(f.lastSuccessAt, now)}.` : 'No successful update yet.'} {f.health === 'unavailable' ? 'Nothing is filled in while the provider is down; retrying automatically.' : 'Showing the last reported information; retrying automatically.'}
            {f.error && <span className="banner-detail"> Provider response: {f.error}</span>}
          </p>
        </section>
      ))}
    </div>
  );
}

function MiniList({ games }: { games: GameSummary[] }) {
  return (
    <ul className="mini-list">
      {games.map((g) => (
        <li key={g.id}>
          <button type="button" className="mini-row" onClick={() => navigate({ name: 'game', id: g.id })}>
            <span className="mini-teams">
              {g.away.abbreviation} at {g.home.abbreviation}
            </span>
            <span className="mini-meta mono">{g.status.kind === 'scheduled' ? kickoffShort(g.startTime) : `${g.score.away ?? ''}-${g.score.home ?? ''} ${statusShort(g.status)}`}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function QuietDay({ model, noGames }: { model: SlateModel; noGames: boolean }) {
  const today = useLive((s) => s.hello?.today ?? null);
  const source = useLive((s) => s.source);
  const replayAvailable = useLive((s) => s.health?.replayAvailable ?? true);
  const league = usePrefs((s) => s.league);
  const leagues: LeagueId[] = league === 'all' ? ['nfl', 'cfb'] : [league];
  // a feed that never answered leaves its games unknown, so the headline speaks only for the leagues that did
  const unknown = unknownLeagues(model.world.freshness, leagues);
  const known = leagues.filter((l) => !unknown.includes(l));
  const date = model.world.date ?? today;
  const upcomingHere = model.sections.upcoming.length > 0;
  const finalHere = model.sections.final.length > 0;
  const look = useLookaround(true, date, { ahead: !upcomingHere, behind: !finalHere, leagues });
  const title = !unknown.length
    ? noGames
      ? 'No games on this day.'
      : 'No games are live right now.'
    : !known.length
      ? 'Games could not be loaded.'
      : noGames
        ? `No ${leagueNames(known)} games on this day.`
        : `No ${leagueNames(known)} games are live right now.`;
  const text = unknown.length
    ? known.length
      ? `${leagueNames(unknown, true)} data is unavailable right now, so ${leagueNames(unknown)} games are not shown. Nothing is filled in while Gridiron retries.`
      : `${leagueNames(unknown, true)} data is unavailable right now, so Gridiron cannot tell which games are on. Nothing is filled in while it retries.`
    : source.kind === 'replay'
      ? 'The replay has not reached kickoff yet. Press play in the replay bar.'
      : 'Gridiron shows a game as live only when the provider reports it in progress. Nothing here is simulated.';
  return (
    <section className="quiet" aria-labelledby="quiet-title">
      <div className="quiet-main">
        <p className="eyebrow">{date ? dateKeyToLabel(date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Today'}</p>
        <h1 id="quiet-title" className="quiet-title">
          {title}
        </h1>
        <p className="quiet-text">{text}</p>
      </div>
      <div className="quiet-columns">
        <div className="quiet-block">
          <h2 className="eyebrow">Next kickoffs</h2>
          {upcomingHere ? (
            <MiniList games={model.sections.upcoming.slice(0, 4)} />
          ) : look.loading ? (
            <p className="muted">Checking the schedule…</p>
          ) : look.upcoming ? (
            <>
              <p className="quiet-day">{dateKeyToLabel(look.upcoming.date)}</p>
              <MiniList games={look.upcoming.games} />
            </>
          ) : (
            <p className="muted">{look.aheadFailed ? 'The upcoming schedule could not be loaded.' : 'No kickoffs found in the next seven days.'}</p>
          )}
        </div>
        <div className="quiet-block">
          <h2 className="eyebrow">Completed</h2>
          {finalHere ? (
            <p className="muted">
              {model.sections.final.length} final {model.sections.final.length === 1 ? 'score' : 'scores'} below.
            </p>
          ) : look.loading ? (
            <p className="muted">Checking recent results…</p>
          ) : look.recent ? (
            <>
              <p className="quiet-day">{dateKeyToLabel(look.recent.date)}</p>
              <MiniList games={look.recent.games} />
            </>
          ) : (
            <p className="muted">{look.behindFailed ? 'Recent results could not be loaded.' : 'No recent final scores found.'}</p>
          )}
        </div>
        <div className="quiet-block quiet-demo">
          <h2 className="eyebrow">Demo</h2>
          {replayAvailable ? (
            <>
              <p>Replay captured real games through the same pipeline as live. Replays are labeled on every screen and never mixed into live data.</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => useUi.getState().setDialog('replay')}>
                <FlaskConical size={14} aria-hidden="true" /> Open the replay lab
              </button>
            </>
          ) : (
            <p>The replay lab runs on the persistent Gridiron server and is not offered on this deployment.</p>
          )}
        </div>
      </div>
    </section>
  );
}

export function LoadingState({ title = 'Loading the slate' }: { title?: string }) {
  const connection = useLive((s) => s.connection);
  const offline = connection.status === 'offline';
  return (
    <div className="state-block" aria-busy={!offline}>
      <p className="eyebrow">{offline ? 'Not connected' : 'Connecting'}</p>
      <h1 className="state-title">{offline ? 'The Gridiron server is not reachable.' : title}</h1>
      <p className="muted">{connection.error ?? 'Waiting for real data from the provider. Nothing is shown until it arrives.'}</p>
      {!offline && (
        <div className="card-grid grid-card skeleton-grid" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      )}
    </div>
  );
}

export function BufferingState({ readyInMs }: { readyInMs: number }) {
  return (
    <div className="state-block">
      <p className="eyebrow">Spoiler delay</p>
      <h1 className="state-title">Buffering</h1>
      <p className="muted">The first delayed update is ready in about {Math.max(1, Math.ceil(readyInMs / 1000))} seconds. Nothing newer is shown before then.</p>
    </div>
  );
}

export function SlateView() {
  const model = useSlateModel();
  const density = usePrefs((s) => s.density);
  const dayMode = usePrefs((s) => s.dayMode);
  const presented = useLive((s) => s.presented);
  const variant = density === 'compact' ? 'compact' : 'card';
  const { sections, world } = model;

  useEffect(() => {
    document.title = 'Gridiron · Every game. Every drive. One view.';
  }, []);

  if (presented.status === 'buffering') return <BufferingState readyInMs={presented.readyInMs} />;
  if (!world.loaded) return <LoadingState />;

  const noGames = model.inScope.length === 0;
  const showQuiet = sections.live.length === 0 && (dayMode !== 'date' || noGames);
  return (
    <>
      <h1 className="sr-only">Slate</h1>
      <SummaryStrip model={model} />
      <DigestPanel world={world} />
      <ProviderNotices model={model} />
      {showQuiet && <QuietDay model={model} noGames={noGames} />}
      {(['live', 'upcoming', 'final', 'other'] as const).map((s) =>
        sections[s].length ? (
          <section key={s} className={`slate-section section-${s}`} aria-labelledby={`sec-${s}`}>
            <header className="section-head">
              <h2 id={`sec-${s}`}>{SECTION_TITLES[s]}</h2>
              <span className="section-count mono">{sections[s].length}</span>
            </header>
            <GameGrid games={sections[s]} model={model} variant={variant} />
          </section>
        ) : null,
      )}
      {!noGames && model.shown.length === 0 && (
        <div className="state-block">
          <h2 className="state-title">No games match these filters</h2>
          <p className="muted">{model.inScope.length} games are on this day.</p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              usePrefs.getState().set({ filters: DEFAULT_FILTERS });
              useUi.getState().setSlateQuery('');
            }}
          >
            Clear filters and search
          </button>
        </div>
      )}
    </>
  );
}
