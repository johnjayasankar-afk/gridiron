/**
 * A slim win probability meter for cards, the game page and the pop-out: each team's
 * share in its color, the leader's chance as text, and for a few seconds the change the
 * latest play made. Values are the provider's model output after the latest play, or
 * before kickoff its matchup predictor. Nothing here is calculated from the score.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GameDetail, GameSummary } from '../../shared/model';
import { isLiveOrPaused } from '../../shared/model';
import { formatChance, formatSwing } from '../../shared/odds';
import { currentWinProbability, predictorShare } from '../../shared/winProbability';
import { accentFor } from '../field/color';
import { useIsDark } from '../lib/theme';

const SWING_MS = 4_500;
/** The last value each game's meter showed, so a meter that remounts does not replay an old swing. */
const shown = new Map<string, { playId: string | null; home: number }>();

export interface WinProbabilityMeterProps {
  game: GameSummary;
  detail: GameDetail | null;
  size?: 'card' | 'large';
  /** A specific value to show instead of the latest, such as the value at an inspected play. */
  at?: { home: number; tie: number } | null;
  /** Hidden from assistive technology where the same information is already in text. */
  decorative?: boolean;
  className?: string;
}

export function WinProbabilityMeter({ game, detail, size = 'card', at = null, decorative = false, className = '' }: WinProbabilityMeterProps) {
  const dark = useIsDark();
  const latest = isLiveOrPaused(game.status.kind) ? currentWinProbability(game, detail) : null;
  const predicted = game.status.kind === 'scheduled' && game.predictor ? predictorShare(game.predictor) : null;
  const [swing, setSwing] = useState<{ delta: number; key: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPlay = latest?.playId ?? null;
  const latestHome = latest?.home ?? null;

  useEffect(() => {
    if (latestHome === null || at) return;
    const before = shown.get(game.id);
    shown.set(game.id, { playId: latestPlay, home: latestHome });
    if (!before || before.playId === latestPlay) return;
    const delta = latestHome - before.home;
    if (Math.abs(delta) < 0.01) return;
    setSwing({ delta, key: String(latestPlay) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSwing(null), SWING_MS);
  }, [game.id, latestPlay, latestHome, at]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const value = at ?? (latest ? { home: latest.home, tie: latest.tie } : predicted !== null ? { home: predicted, tie: 0 } : null);
  if (!value) return null;
  const pregame = !at && !latest;
  const home = value.home;
  const tie = value.tie;
  const away = Math.max(0, 1 - home - tie);
  const leader = home >= away ? game.home : game.away;
  const style = { '--wp-home': accentFor(game.home.color, dark), '--wp-away': accentFor(game.away.color, dark) } as CSSProperties;
  const label = `${pregame ? 'ESPN matchup predictor' : 'ESPN win probability'}: ${game.away.displayName} ${formatChance(away)}, ${game.home.displayName} ${formatChance(home)}${tie >= 0.005 ? `, tie ${formatChance(tie)}` : ''}.`;
  const gainer = swing ? (swing.delta > 0 ? game.home : game.away) : null;

  return (
    <div className={`wp-meter is-${size}${pregame ? ' is-pregame' : ''} ${className}`} style={style} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}>
      <span className="wp-label mono" aria-hidden="true">
        {pregame ? 'Predictor' : 'Win prob'}
      </span>
      <span className="wp-track" aria-hidden="true">
        <span className="wp-fill is-away" style={{ width: `${away * 100}%` }} />
        {tie >= 0.005 && <span className="wp-fill is-tie" style={{ width: `${tie * 100}%` }} />}
        <span className="wp-fill is-home" style={{ width: `${home * 100}%` }} />
      </span>
      <span className="wp-read mono" aria-hidden="true">
        <span className="wp-team">{leader.abbreviation}</span> {formatChance(Math.max(home, away))}
      </span>
      {swing && gainer && (
        <span key={swing.key} className="wp-swing mono" aria-hidden="true">
          {gainer.abbreviation} {formatSwing(Math.abs(swing.delta))}
        </span>
      )}
    </div>
  );
}
