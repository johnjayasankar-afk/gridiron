/**
 * The scorebug, on the field where a broadcast puts it.
 *
 * The scoreboard above the field says who is playing and what the score is. It
 * cannot say what a broadcast bug says, which is the state of the down: who has
 * the ball, what they face, where it is, and what each side has left to stop the
 * clock with. All of that is reported, and all of it belongs on the field rather
 * than in a panel beside it, because it is what you are looking at the field to
 * find out.
 *
 * It makes the field self-contained. On the wall, in a pop-out, or simply
 * scrolled past the scoreboard, the field alone now answers the question.
 *
 * Every figure is reported or absent. A down nobody reported is not drawn as
 * first and ten, a timeout count nobody reported is not drawn as three, and a
 * possession nobody reported moves no marker. It is hidden from screen readers
 * because every value in it is already in the scoreboard and the situation panel
 * in prose, and a second reading of the same numbers is noise rather than help.
 */
import { memo } from 'react';
import { periodShort } from '../../shared/util';
import { statusShort } from '../../shared/format';
import type { GameSummary, Side, Situation } from '../../shared/model';
import { accentFor } from './color';
import { useScoreRoll } from '../components/Score';

/** How many timeouts a side starts a half with, which is what the pips are drawn against. */
const TIMEOUTS = 3;

function Team({ game, side, score, hasBall, timeouts }: { game: GameSummary; side: Side; score: number | null; hasBall: boolean; timeouts: number | null }) {
  const team = game[side];
  // The same roll the scoreboard's numbers use, so scrubbing moves both together.
  const roll = useScoreRoll(score);
  return (
    <div className={`bug-team${hasBall ? ' has-ball' : ''}`}>
      <span className="bug-bar" style={{ background: accentFor(team.color, true) }} aria-hidden="true" />
      <span className="bug-abbr">{team.abbreviation}</span>
      <span className={`bug-score mono${roll ? ` roll-${roll}` : ''}`}>
        <span key={score ?? 'none'} className="score-num">
          {score ?? '-'}
        </span>
      </span>
      {/* Three pips, unlit as they are spent. Nothing is drawn at all where the provider reported no count. */}
      {timeouts !== null && (
        <span className="bug-timeouts">
          {Array.from({ length: TIMEOUTS }, (_, i) => (
            <span key={i} className={`bug-pip${i < timeouts ? ' is-left' : ''}`} />
          ))}
        </span>
      )}
    </div>
  );
}

export const ScoreBug = memo(function ScoreBug({ game, situation }: { game: GameSummary; situation: Situation | null }) {
  /*
   * Nothing before kickoff. A broadcast does not put a bug up over a game that
   * has not started, and there is nothing for it to say: it read "IOWA - MICH -"
   * beside an empty clock, which is two dashes and a box. The field already
   * carries the kickoff time for a scheduled game, which is the answer to the
   * only question there is.
   */
  if (game.status.kind === 'scheduled') return null;
  /*
   * Straight off the game, because the game handed in is already the game as it
   * stood at the play being looked at (shared/replayFrames, gameAtFrame). The
   * bug used to take the period and the clock separately and read the score off
   * a game that had moved on, which is how it came to show a final score beside
   * a first quarter clock.
   */
  const period = game.status.period;
  const clock = game.status.clock;
  const possession = situation?.possession ?? null;
  /*
   * The provider's own words for the down where it gave them, because "3rd & 7"
   * is its phrasing and rewriting it from the parts risks saying something it did
   * not. Goal to go is its phrasing too.
   */
  const down = situation?.downDistanceText ?? null;
  const spot = situation?.spot.label ?? null;
  const redZone = situation?.isRedZone === true;

  return (
    <div className={`score-bug${redZone ? ' is-redzone' : ''}`} aria-hidden="true">
      <div className="bug-teams">
        <Team game={game} side="away" score={game.score.away} hasBall={possession === 'away'} timeouts={situation?.timeouts.away ?? null} />
        <Team game={game} side="home" score={game.score.home} hasBall={possession === 'home'} timeouts={situation?.timeouts.home ?? null} />
      </div>
      {/*
        A running clock only while the clock is running. Everything else is the
        state in a word, from the same place the status pill takes it: the bug
        said "Q4" and nothing else on a finished game, because the period was all
        it read, and a broadcast bug on a finished game says FINAL.
      */}
      <div className="bug-clock">
        {game.status.kind === 'in_progress' ? (
          <>
            <span className="bug-period mono">{periodShort(period, game.status.regulationPeriods) ?? 'LIVE'}</span>
            {clock && <span className="bug-time mono">{clock}</span>}
          </>
        ) : (
          <span className="bug-state mono">{statusShort(game.status).toUpperCase()}</span>
        )}
      </div>
      {/*
        The red zone is worth its own row even when the provider gave no down
        text with it: being inside the twenty is the thing a broadcast never lets
        you miss, and hiding it behind a down that was not reported would lose it
        exactly when it matters.
      */}
      {(down || spot || redZone) && (
        <div className="bug-down">
          {(down || spot) && <span className="bug-dd">{down ?? spot}</span>}
          {redZone && <span className="bug-flag">RED ZONE</span>}
        </div>
      )}
    </div>
  );
});
