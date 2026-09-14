/** "While you were away": a digest of what was reported across the slate since the viewer left. */
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { navigate } from '../app/router';
import { clockTime } from '../lib/time';
import { useDigest } from '../state/digest';
import { useLive, type World } from '../state/live';
import { bestSummary } from '../state/selectors';
import { IconButton } from './controls';
import { TeamLogo } from './TeamLogo';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function awayFor(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
const scoreOf = (s: { home: number | null; away: number | null }) => (s.home === null || s.away === null ? '·' : `${s.away}-${s.home}`);

export function DigestPanel({ world }: { world: World }) {
  const digest = useDigest((s) => s.digest);
  const replay = useLive((s) => s.source.kind === 'replay');
  const [expanded, setExpanded] = useState(false);
  const returnedAt = useMemo(() => Date.now(), [digest]);
  if (!digest) return null;
  const { totals } = digest;
  const summary = [
    totals.scores ? plural(totals.scores, 'score') : null,
    totals.turnovers ? plural(totals.turnovers, 'turnover') : null,
    totals.finals ? plural(totals.finals, 'final') : null,
    totals.kickoffs ? plural(totals.kickoffs, 'kickoff') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const entries = expanded ? digest.entries : digest.entries.slice(0, 6);

  return (
    <section className="digest" aria-labelledby="digest-title">
      <header className="digest-head">
        <div>
          {/* A replay runs on its own clock, so it shows time away rather than a wall-clock time. */}
          <p className="eyebrow">{replay ? `Away ${awayFor(returnedAt - digest.since)}` : `Since ${clockTime(digest.since)}`}</p>
          <h2 id="digest-title" className="digest-title">
            While you were away
          </h2>
          <p className="digest-summary">
            {summary} across {plural(digest.entries.length, 'game')}
          </p>
        </div>
        <IconButton label="Dismiss the summary" icon={X} onClick={() => useDigest.getState().dismiss()} />
      </header>
      <ul className="digest-list">
        {entries.map((entry) => {
          const game = bestSummary(world, entry.gameId);
          if (!game) return null;
          const plays = world.details[game.id]?.detail?.plays ?? [];
          return (
            <li key={entry.gameId} className="digest-item">
              <button type="button" className="digest-game" onClick={() => navigate({ name: 'game', id: game.id })}>
                <span className="digest-teams">
                  <TeamLogo team={game.away} size={22} />
                  <span>{game.away.abbreviation}</span>
                  <span className="muted">at</span>
                  <TeamLogo team={game.home} size={22} />
                  <span>{game.home.abbreviation}</span>
                </span>
                <span className="digest-score mono">
                  {scoreOf(entry.before)} <span aria-hidden="true">→</span>
                  <span className="sr-only"> to </span> {scoreOf(entry.after)}
                </span>
                <span className="digest-headline">{entry.headline}</span>
              </button>
              <ul className="digest-lines">
                {entry.items
                  .filter((item) => item.tone !== 'status' || entry.items.length === 1)
                  .slice(0, 3)
                  .map((item, i) => {
                    const providerId = item.order === null ? null : (plays.find((p) => p.order === item.order)?.providerId ?? null);
                    return (
                      <li key={`${item.order ?? 's'}-${i}`} className={`tone-${item.tone}`}>
                        {providerId ? (
                          <button type="button" className="digest-line-btn" onClick={() => navigate({ name: 'game', id: game.id }, { params: { play: providerId } })}>
                            {item.when && <span className="mono">{item.when}</span>} {item.text}
                          </button>
                        ) : (
                          <span>{item.text}</span>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </li>
          );
        })}
      </ul>
      {digest.entries.length > 6 && (
        <button type="button" className="link-btn digest-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${digest.entries.length} games`}
        </button>
      )}
    </section>
  );
}
