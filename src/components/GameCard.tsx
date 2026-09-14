/**
 * A game card: header, teams and score, situation, win probability and odds, field,
 * footer. States: live, paused, scheduled, final, stale ("Updates delayed"),
 * score-only coverage, and last-known spot. Text is DOM; the field is decoration plus
 * position, described for screen readers in the card link.
 */
import { Bell, BellOff, Crosshair, Pin, PinOff } from 'lucide-react';
import { memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { accessibleSummary, downDistance, SPOT_UNAVAILABLE, spotLabel, statusShort, teamFor } from '../../shared/format';
import type { DetailState } from '../state/live';
import { DIVISION_LABEL, isLiveOrPaused, type GameSummary, type Side, type Team } from '../../shared/model';
import { formatChance } from '../../shared/odds';
import type { WatchItem } from '../../shared/watch';
import { currentWinProbability } from '../../shared/winProbability';
import { navigate } from '../app/router';
import { accentFor } from '../field/color';
import { FieldView } from '../field/FieldView';
import { createPointerState, requestFieldFrame } from '../field/frameBus';
import { usePlayAnimation } from '../field/usePlayAnimation';
import { useReducedMotion } from '../lib/motion';
import { useIsDark } from '../lib/theme';
import { kickoffShort } from '../lib/time';
import { useFeed } from '../state/feed';
import { usePrefs } from '../state/prefs';
import { displaySituation, sectionOf } from '../state/selectors';
import { observeCard } from '../state/ui';
import { IconButton } from './controls';
import { DriveStrip } from './DriveStrip';
import { OddsStrip } from './OddsStrip';
import { Score } from './Score';
import { StatusPill } from './StatusPill';
import { TeamLogo } from './TeamLogo';
import { WinProbabilityMeter } from './WinProbabilityMeter';

export interface GameCardProps {
  game: GameSummary;
  detail: DetailState | undefined;
  variant: 'card' | 'compact';
  stale: boolean;
  afterGap: boolean;
  watch?: WatchItem | null;
  /** Extra controls, for example Focus slot replace and swap. */
  slotControls?: ReactNode;
  showActions?: boolean;
  /** Changes when Director mode cuts to this game, for a camera cut on the field. */
  cutToken?: number;
}

export function leagueLabel(game: GameSummary): string {
  if (game.league === 'nfl') return 'NFL';
  return game.divisions.length ? game.divisions.map((d) => DIVISION_LABEL[d]).join(' · ') : 'College';
}

export function primaryBroadcast(game: GameSummary): string | null {
  const tv = game.broadcasts.find((b) => b.medium === 'tv' && b.national !== false) ?? game.broadcasts.find((b) => b.medium === 'tv') ?? game.broadcasts[0];
  return tv?.name ?? null;
}

export function fieldMessage(game: GameSummary, hasSpot: boolean): string | null {
  const k = game.status.kind;
  if (k === 'scheduled') return `Kickoff ${kickoffShort(game.startTime)}`;
  if (k === 'final') return statusShort(game.status);
  if (k === 'postponed' || k === 'canceled' || k === 'unknown') return statusShort(game.status);
  if (k === 'halftime' && !hasSpot) return 'Halftime';
  if (game.coverage.level === 'score-only' && !hasSpot) return 'Score-only coverage';
  if (!hasSpot) return SPOT_UNAVAILABLE;
  return null;
}

function TeamRow({ team, score, possession, result, compact }: { team: Team; score: number | null; possession: boolean; result: 'win' | 'loss' | null; compact: boolean }) {
  return (
    <span className={`team-row${result ? ` is-${result}` : ''}`}>
      <TeamLogo team={team} size={compact ? 22 : 30} />
      <span className="team-name">
        {team.rank !== null && <span className="team-rank mono">{team.rank}</span>}
        <span className="team-abbr">{team.abbreviation}</span>
        {!compact && <span className="team-short">{team.shortName}</span>}
        {!compact && team.record && <span className="team-record mono">{team.record}</span>}
      </span>
      <span className={`possession${possession ? ' is-on' : ''}`} aria-hidden="true" />
      <Score value={score} />
    </span>
  );
}

export const GameCard = memo(function GameCard({ game, detail, variant, stale, afterGap, watch, slotControls, showActions = true, cutToken }: GameCardProps) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const [lifted, setLifted] = useState(false);
  const [pointer] = useState(createPointerState);
  const compact = variant === 'compact';
  const reducedMotion = useReducedMotion();
  const { situation, lastKnown } = displaySituation(game, detail?.detail ?? null);
  const moment = usePlayAnimation(detail?.detail ?? null, situation, { reducedMotion, afterGap, paused: false });
  const pinned = usePrefs((s) => s.pinned.includes(game.id));
  const muted = usePrefs((s) => s.mutedGames.includes(game.id));
  const inFocus = usePrefs((s) => s.focusGames.includes(game.id));
  const showOdds = usePrefs((s) => s.showOdds);
  const badge = useFeed((s) => s.badges[game.id]);
  const dark = useIsDark();
  // Team light for the hover glow, and a per-card offset so live sheens do not sweep in unison.
  const surface = useMemo(() => {
    let hash = 0;
    for (const ch of game.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return { '--team-away': accentFor(game.away.color, dark), '--team-home': accentFor(game.home.color, dark), '--sheen-delay': `${(hash % 70) / 10}s` } as CSSProperties;
  }, [game.id, game.away.color, game.home.color, dark]);

  useEffect(() => {
    const el = ref.current;
    return el ? observeCard(el, game.id) : undefined;
  }, [game.id]);

  const live = isLiveOrPaused(game.status.kind);
  const scheduled = game.status.kind === 'scheduled';
  const hasSpot = live && situation !== null && situation.spot.schematicYard !== null;
  const message = fieldMessage(game, hasSpot);
  const final = game.status.kind === 'final';
  const { home, away } = game.score;
  const result = (side: Side): 'win' | 'loss' | null => {
    if (!final || home === null || away === null || home === away) return null;
    const winner: Side = home > away ? 'home' : 'away';
    return winner === side ? 'win' : 'loss';
  };
  const possession = live ? (situation?.possession ?? null) : null;
  const broadcast = primaryBroadcast(game);
  const recentBadge = badge && badge.status === 'active' && Date.now() - badge.receivedAt < 120_000 ? badge : null;
  const winProbability = showOdds && live ? currentWinProbability(game, detail?.detail ?? null) : null;
  const winProbabilityText = winProbability
    ? ` ESPN win probability: ${game.away.abbreviation} ${formatChance(Math.max(0, 1 - winProbability.home - winProbability.tie))}, ${game.home.abbreviation} ${formatChance(winProbability.home)}.`
    : '';

  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate({ name: 'game', id: game.id });
  };

  const situationText = (() => {
    if (!live) {
      if (scheduled) return [broadcast, game.venue?.name].filter(Boolean).join(' · ') || 'Scheduled';
      return game.notes[0] ?? (game.venue?.name ? `${game.venue.name}` : statusShort(game.status));
    }
    if (!situation) return game.coverage.level === 'score-only' ? 'Score-only coverage: no play-by-play' : 'Situation not reported';
    const team = teamFor(game, situation.possession);
    return [team ? `${team.abbreviation} ball` : 'Possession not reported', downDistance(situation), spotLabel(situation.spot, game)].filter(Boolean).join(' · ');
  })();
  const redZone = hasSpot && (situation?.spot.progress ?? 0) >= 80;
  const lastPlay = live ? (situation?.lastPlay?.description ?? null) : null;

  return (
    <article
      ref={ref}
      className={`card card-${variant} state-${sectionOf(game)}${stale ? ' is-stale' : ''}${pinned ? ' is-pinned' : ''}`}
      data-game={game.id}
      aria-labelledby={`${id}-link`}
      style={surface}
      onPointerEnter={(e) => e.pointerType === 'mouse' && setLifted(true)}
      onPointerMove={(e) => {
        if (e.pointerType !== 'mouse') return;
        const rect = e.currentTarget.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        pointer.active = true;
        requestFieldFrame();
      }}
      onPointerLeave={() => {
        setLifted(false);
        pointer.active = false;
        requestFieldFrame();
      }}
      onFocus={() => setLifted(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLifted(false);
      }}
    >
      <span className="card-fx" aria-hidden="true" />
      <header className="card-head">
        <span className="card-meta mono">
          {leagueLabel(game)}
          {!compact && broadcast && <span className="card-broadcast"> · {broadcast}</span>}
        </span>
        {recentBadge && !compact && <span className={`card-badge kind-${recentBadge.kind}`}>{recentBadge.title.split(':')[0]}</span>}
        <StatusPill game={game} stale={stale} />
      </header>

      <a className="card-link" href={`/game/${encodeURIComponent(game.id)}`} onClick={open} id={`${id}-link`}>
        <span className="sr-only">
          {accessibleSummary(game, situation)}
          {stale ? ' Updates are delayed.' : ''}
          {winProbabilityText} Open game.
        </span>
        <span className="card-teams" aria-hidden="true">
          <TeamRow team={game.away} score={away} possession={possession === 'away'} result={result('away')} compact={compact} />
          <TeamRow team={game.home} score={home} possession={possession === 'home'} result={result('home')} compact={compact} />
        </span>
      </a>

      <p className="card-situation mono" aria-hidden="true">
        <span className="card-situation-text">{situationText}</span>
        {redZone && <span className="tag tag-attention">Red zone</span>}
        {watch && !compact && <span className="tag tag-live" title={watch.reasons.join(' · ')}>{watch.label}</span>}
      </p>

      {showOdds && (live || scheduled) && (
        <div className="card-odds">
          <WinProbabilityMeter game={game} detail={detail?.detail ?? null} decorative />
          {!compact && <OddsStrip game={game} />}
        </div>
      )}

      <FieldView game={game} situation={hasSpot ? situation : null} animation={moment.animation} variant={variant} hidden={!hasSpot} cutToken={cutToken} lift={lifted} pointer={pointer}>
        {stale && <span className="field-dim" aria-hidden="true" />}
        {message && <span className="field-message">{message}</span>}
        <span className="field-tags" aria-hidden="true">
          {stale && <span className="field-tag tag-stale">Updates delayed</span>}
          {lastKnown && hasSpot && <span className="field-tag">Last known spot</span>}
        </span>
        {moment.label && (
          <span key={moment.labelKey} className={`field-label${moment.corrected ? ' is-correction' : ''}`} aria-hidden="true">
            {moment.label}
          </span>
        )}
        {live && <DriveStrip game={game} entry={detail} situation={situation} compact={compact} />}
      </FieldView>

      {!compact && (
        <footer className="card-foot">
          <p className="card-last">{lastPlay ?? ' '}</p>
          {showActions && (
            <div className="card-actions">
              {slotControls}
              <IconButton label={pinned ? 'Unpin game' : 'Pin game to the top'} icon={pinned ? PinOff : Pin} pressed={pinned} onClick={() => usePrefs.getState().togglePin(game.id)} />
              <IconButton label={inFocus ? 'Remove from focus' : 'Add to focus'} icon={Crosshair} pressed={inFocus} onClick={() => (inFocus ? usePrefs.getState().removeFromFocus(game.id) : usePrefs.getState().addToFocus(game.id))} />
              <IconButton label={muted ? 'Unmute alerts for this game' : 'Mute alerts for this game'} icon={muted ? BellOff : Bell} pressed={muted} onClick={() => usePrefs.getState().toggleMute(game.id)} />
            </div>
          )}
        </footer>
      )}
    </article>
  );
});
