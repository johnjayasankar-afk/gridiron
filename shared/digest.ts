/**
 * "While you were away": what the provider reported across the slate between a
 * snapshot and now. Built from reported plays when play-by-play is loaded; from
 * the scoreboard otherwise, where a score change that no play explains is
 * labeled as exactly that. History from before the snapshot is never included.
 */
import { scoreText } from './format.js';
import type { GameDetail, GameId, GameStatusKind, GameSummary } from './model.js';
import { isLiveOrPaused } from './model.js';
import { catchUp, inspectablePlays } from './replayFrames.js';

export interface DigestGameSnapshot {
  home: number | null;
  away: number | null;
  kind: GameStatusKind;
  /** Last inspectable play order known at the snapshot, when play-by-play was loaded. */
  lastOrder: number | null;
}

export interface DigestSnapshot {
  at: number;
  games: Record<GameId, DigestGameSnapshot>;
}

export interface DigestItem {
  /** Play order to open, when the item comes from a reported play. */
  order: number | null;
  when: string;
  text: string;
  tone: 'score' | 'turnover' | 'status';
}

export interface DigestEntry {
  gameId: GameId;
  before: { home: number | null; away: number | null; kind: GameStatusKind };
  after: { home: number | null; away: number | null; kind: GameStatusKind };
  items: DigestItem[];
  headline: string;
  weight: number;
}

export interface Digest {
  since: number;
  entries: DigestEntry[];
  totals: { scores: number; turnovers: number; finals: number; kickoffs: number };
}

type Details = Record<GameId, GameDetail | null | undefined>;

export function takeDigestSnapshot(games: GameSummary[], details: Details, at: number): DigestSnapshot {
  const snapshot: DigestSnapshot = { at, games: {} };
  for (const g of games) {
    const d = details[g.id];
    const plays = d ? inspectablePlays(d) : [];
    snapshot.games[g.id] = { home: g.score.home, away: g.score.away, kind: g.status.kind, lastOrder: plays.length ? plays[plays.length - 1].order : null };
  }
  return snapshot;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function buildDigest(snapshot: DigestSnapshot, games: GameSummary[], details: Details, options: { bigPlayYards: number }): Digest {
  const entries: DigestEntry[] = [];
  const totals = { scores: 0, turnovers: 0, finals: 0, kickoffs: 0 };

  for (const g of games) {
    const before = snapshot.games[g.id];
    if (!before) continue;
    const after = { home: g.score.home, away: g.score.away, kind: g.status.kind };
    const items: DigestItem[] = [];
    let scores = 0;
    let turnovers = 0;

    const kickedOff = before.kind === 'scheduled' && (isLiveOrPaused(after.kind) || after.kind === 'final');
    if (kickedOff) {
      items.push({ order: null, when: '', text: 'Kicked off', tone: 'status' });
      totals.kickoffs++;
    }

    const detail = details[g.id];
    // Play-by-play explains what happened only if we know where we left off, or the game had not started.
    const fromPlays = detail && inspectablePlays(detail).length > 0 && (before.lastOrder !== null || before.kind === 'scheduled');
    if (fromPlays) {
      const summary = catchUp(detail, before.lastOrder, options.bigPlayYards);
      for (const item of summary.items) {
        if (item.tone === 'big') continue;
        items.push({ order: item.order, when: item.when, text: item.text, tone: item.tone });
        if (item.tone === 'score') scores++;
        else turnovers++;
      }
    }
    const scoreKnown = before.home !== null && before.away !== null && after.home !== null && after.away !== null;
    const scoreMoved = scoreKnown && (before.home !== after.home || before.away !== after.away);
    if (scoreMoved && scores === 0) {
      items.push({ order: null, when: '', text: `Score changed: ${before.away}-${before.home} to ${after.away}-${after.home}`, tone: 'score' });
      scores++;
    }

    const finished = before.kind !== 'final' && after.kind === 'final';
    if (finished) {
      items.push({ order: null, when: '', text: `Final: ${scoreText(g)}`, tone: 'status' });
      totals.finals++;
    }

    if (!items.length) continue;
    totals.scores += scores;
    totals.turnovers += turnovers;
    const parts = [scores ? plural(scores, 'score') : null, turnovers ? plural(turnovers, 'turnover') : null, finished ? 'final' : null, kickedOff && !finished ? 'kicked off' : null].filter(Boolean);
    entries.push({
      gameId: g.id,
      before: { home: before.home, away: before.away, kind: before.kind },
      after,
      items,
      headline: parts.join(', '),
      weight: scores * 3 + turnovers * 2 + (finished ? 2 : 0) + (kickedOff ? 1 : 0),
    });
  }

  entries.sort((a, b) => b.weight - a.weight || a.gameId.localeCompare(b.gameId));
  return { since: snapshot.at, entries, totals };
}
