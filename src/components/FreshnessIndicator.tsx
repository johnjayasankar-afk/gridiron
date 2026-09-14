/**
 * How current the information is: connection state, last successful fetch per
 * league, stale play-by-play, and provider outages. It never implies that data
 * is newer than the last successful response.
 */
import type { Freshness, LeagueId } from '../../shared/model';
import { LEAGUES } from '../../shared/model';
import { useNow } from '../lib/motion';
import { clockTimeSeconds, formatAgo } from '../lib/time';
import { useLive } from '../state/live';
import { usePrefs } from '../state/prefs';
import { Popover } from './controls';

type State = 'connecting' | 'connected' | 'reconnecting' | 'stale' | 'unavailable' | 'offline';

const LABEL: Record<State, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  stale: 'Updates delayed',
  unavailable: 'Provider unavailable',
  offline: 'Offline',
};

const newest = (values: Array<string | null>) => values.filter((v): v is string => !!v).sort().pop() ?? null;

export function useFeedState(): { state: State; lastSuccess: string | null } {
  const connection = useLive((s) => s.connection);
  const world = useLive((s) => s.world);
  const league = usePrefs((s) => s.league);
  const leagues: LeagueId[] = league === 'all' ? ['nfl', 'cfb'] : [league];
  const fresh = leagues.map((l) => world.freshness[l]);
  const lastSuccess = newest(fresh.map((f) => f.lastSuccessAt));
  let state: State;
  if (connection.status === 'offline') state = 'offline';
  else if (connection.status === 'reconnecting') state = 'reconnecting';
  else if (!world.loaded) state = 'connecting';
  else if (fresh.every((f) => f.health === 'unavailable')) state = 'unavailable';
  else if (fresh.some((f) => f.health === 'stale' || f.health === 'unavailable')) state = 'stale';
  else state = 'connected';
  return { state, lastSuccess };
}

function LeagueRow({ id, f, now }: { id: LeagueId; f: Freshness; now: number }) {
  return (
    <div className="fresh-row">
      <span className="fresh-league">{LEAGUES[id].shortName}</span>
      <span className={`fresh-health health-${f.health}`}>{f.health === 'idle' ? 'Not requested' : f.health === 'connected' ? 'OK' : f.health === 'stale' ? 'Delayed' : f.health === 'unavailable' ? 'Unavailable' : 'Reconnecting'}</span>
      <span className="fresh-when mono" title={f.lastSuccessAt ? clockTimeSeconds(Date.parse(f.lastSuccessAt)) : undefined}>
        {f.lastSuccessAt ? `fetched ${formatAgo(f.lastSuccessAt, now)}` : 'no data yet'}
      </span>
      {f.lastChangeAt && <span className="fresh-when mono">changed {formatAgo(f.lastChangeAt, now)}</span>}
      {f.error && <span className="fresh-error">{f.error}</span>}
    </div>
  );
}

export function FreshnessIndicator() {
  const now = useNow(1000);
  const { state, lastSuccess } = useFeedState();
  const connection = useLive((s) => s.connection);
  const world = useLive((s) => s.world);
  const source = useLive((s) => s.source);
  const details = Object.values(world.details);
  const staleDetails = details.filter((d) => d.freshness.health === 'stale' || d.freshness.health === 'unavailable').length;
  const short = state === 'connected' ? (lastSuccess ? formatAgo(lastSuccess, now) : 'Connected') : LABEL[state];
  const mode = world.mode === 'replay' || source.kind === 'replay' ? 'Replay' : 'Live';

  return (
    <Popover
      label="Data freshness"
      align="end"
      buttonClassName={`fresh-btn state-${state}`}
      trigger={
        <>
          <span className="fresh-dot" aria-hidden="true" />
          <span className="fresh-mode mono">{mode}</span>
          <span className="fresh-short">{short}</span>
          <span className="sr-only">. {LABEL[state]}. Show data freshness details.</span>
        </>
      }
    >
      <div className="fresh-panel">
        <p className="eyebrow">Data freshness</p>
        <p className="fresh-summary">
          <strong>{LABEL[state]}</strong>
          {connection.transport && <span className="mono"> · {connection.transport === 'sse' ? 'server stream' : 'polling'}</span>}
        </p>
        {connection.error && <p className="fresh-error">{connection.error}</p>}
        <LeagueRow id="nfl" f={world.freshness.nfl} now={now} />
        <LeagueRow id="cfb" f={world.freshness.cfb} now={now} />
        <p className="fresh-note">
          {details.length} games with play-by-play loaded{staleDetails ? `, ${staleDetails} delayed` : ''}. Clocks and spots are shown as last reported by the provider, never counted forward.
        </p>
      </div>
    </Popover>
  );
}
