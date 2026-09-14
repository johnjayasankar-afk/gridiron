/**
 * Plain-language formatting shared by cards, detail views, alerts, the Watch
 * next list and screen-reader summaries. Unknown values are never guessed.
 */
import { describeProgress, labelFromProgress } from './field.js';
import type { BallSpot, GameStatus, GameSummary, Side, Situation, Team } from './model.js';
import { isLiveOrPaused } from './model.js';
import { ordinal, periodLong, periodShort } from './util.js';

export const SPOT_UNAVAILABLE = 'Ball spot unavailable';

export function teamFor(game: GameSummary, side: Side | null): Team | null {
  return side === 'home' ? game.home : side === 'away' ? game.away : null;
}

export function opponentOf(side: Side): Side {
  return side === 'home' ? 'away' : 'home';
}

export function downText(down: number | null): string | null {
  return down === null ? null : ordinal(down);
}

/** "3rd & 7", "1st & Goal", or null when the down is not reported. */
export function downDistance(s: Pick<Situation, 'down' | 'distance' | 'goalToGo'> | null): string | null {
  if (!s || s.down === null) return null;
  if (s.goalToGo) return `${ordinal(s.down)} & Goal`;
  if (s.distance === null) return ordinal(s.down);
  return `${ordinal(s.down)} & ${s.distance}`;
}

/** "NE 35" style label for a spot, or the unavailable message. */
export function spotLabel(spot: BallSpot | null | undefined, game: GameSummary): string {
  if (!spot || spot.schematicYard === null) return SPOT_UNAVAILABLE;
  if (spot.offense && spot.progress !== null) return labelFromProgress(spot.progress, spot.offense, { home: game.home, away: game.away });
  return spot.label ?? SPOT_UNAVAILABLE;
}

/** "BUF ball · 3rd & 7 · NE 35". Parts that are unknown are left out, never filled. */
export function situationLine(game: GameSummary, situation: Situation | null = game.situation): string | null {
  if (!situation) return null;
  const parts: string[] = [];
  const team = teamFor(game, situation.possession);
  if (team) parts.push(`${team.abbreviation} ball`);
  const dd = downDistance(situation);
  if (dd) parts.push(dd);
  parts.push(spotLabel(situation.spot, game));
  return parts.join(' · ');
}

/** Short status for cards: "Q3 7:42", "Halftime", "End Q1", "Final/OT", "Delayed". */
export function statusShort(status: GameStatus): string {
  const p = periodShort(status.period, status.regulationPeriods);
  switch (status.kind) {
    case 'scheduled':
      return 'Scheduled';
    case 'in_progress':
      return [p, status.clock].filter(Boolean).join(' ') || 'In progress';
    case 'halftime':
      return 'Halftime';
    case 'end_of_period':
      return p ? `End ${p}` : 'End of period';
    case 'delayed':
      return p ? `Delayed · ${p}` : 'Delayed';
    case 'suspended':
      return 'Suspended';
    case 'final':
      return status.period !== null && status.period > status.regulationPeriods ? `Final/${periodShort(status.period, status.regulationPeriods)}` : 'Final';
    case 'postponed':
      return 'Postponed';
    case 'canceled':
      return 'Canceled';
    default:
      return status.detail ?? 'Status unknown';
  }
}

export function kickoffLabel(startTime: string | null, timeZone?: string): string {
  if (!startTime) return 'Kickoff time not reported';
  const d = new Date(startTime);
  if (Number.isNaN(d.getTime())) return 'Kickoff time not reported';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone }).format(d);
}

export function scoreText(game: GameSummary): string {
  const a = game.score.away;
  const h = game.score.home;
  if (a === null || h === null) return `${game.away.abbreviation} at ${game.home.abbreviation}`;
  return `${game.away.abbreviation} ${a}, ${game.home.abbreviation} ${h}`;
}

export function leader(game: GameSummary): Side | 'tied' | null {
  const { home, away } = game.score;
  if (home === null || away === null) return null;
  return home === away ? 'tied' : home > away ? 'home' : 'away';
}

export function margin(game: GameSummary): number | null {
  const { home, away } = game.score;
  return home === null || away === null ? null : Math.abs(home - away);
}

/** A sentence a screen reader can speak for a card. */
export function accessibleSummary(game: GameSummary, situation: Situation | null = game.situation): string {
  const s: string[] = [];
  const { home, away } = game.score;
  if (home !== null && away !== null) s.push(`${game.away.displayName} ${away}, ${game.home.displayName} ${home}.`);
  else s.push(`${game.away.displayName} at ${game.home.displayName}.`);
  const st = game.status;
  if (st.kind === 'scheduled') s.push(`Kickoff ${kickoffLabel(game.startTime)}.`);
  else if (st.kind === 'in_progress') s.push(`${periodLong(st.period, st.regulationPeriods) ?? 'In progress'}${st.clock ? `, ${st.clock} on the reported clock` : ''}.`);
  else s.push(`${statusShort(st)}.`);
  if (situation && isLiveOrPaused(st.kind)) {
    const team = teamFor(game, situation.possession);
    const dd = downDistance(situation);
    const spot = situation.spot.schematicYard === null ? 'the ball spot is unavailable' : situation.spot.progress !== null ? `at its ${describeProgress(situation.spot.progress)}` : `at the ${situation.spot.label}`;
    s.push(`${team ? `${team.displayName} have the ball` : 'Possession not reported'}${dd ? `, ${dd.replace('&', 'and')}` : ''}, ${spot}.`);
  }
  if (game.coverage.level === 'score-only') s.push('Score-only coverage: no play-by-play for this game.');
  return s.join(' ');
}

/** "3-point game", "Tied", "10-point game". */
export function marginPhrase(game: GameSummary): string | null {
  const m = margin(game);
  if (m === null) return null;
  return m === 0 ? 'Tied' : `${m}-point game`;
}

export function clockLeftPhrase(status: GameStatus): string | null {
  if (status.clock === null) return null;
  return `${status.clock} left`;
}
