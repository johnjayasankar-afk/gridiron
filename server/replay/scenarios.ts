/**
 * The replay lab's scenarios.
 *
 * Replays of real games use captured ESPN data only. Test scenarios start from
 * a real captured game and apply one explicit, documented edit; they are named
 * and labelled as synthetic everywhere they appear.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PriceCandle } from '../../shared/marketHistory.js';
import type { Division, LeagueId, LinePoint } from '../../shared/model.js';
import { easternDateKey } from '../../shared/util.js';
import { buildTimeline, type CapturedContract, type CapturedLines, type GameTimeline } from './timeline.js';

type Raw = Record<string, any>;

export interface BuiltScenario {
  date: string;
  games: GameTimeline[];
  startAt: number;
  endAt: number;
  limitations: string[];
  /** Virtual-time windows in which the provider fails (test scenarios). */
  outages: Array<{ from: number; until: number }>;
}

export interface ScenarioDef {
  id: string;
  label: string;
  description: string;
  synthetic: boolean;
  speed: number;
  build(fx: FixtureStore): BuiltScenario | null;
}

export class FixtureStore {
  private cache = new Map<string, Raw | null>();
  constructor(readonly dir: string) {}
  json(rel: string): Raw | null {
    if (!this.cache.has(rel)) {
      const file = join(this.dir, rel);
      this.cache.set(rel, existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Raw) : null);
    }
    return this.cache.get(rel) ?? null;
  }

  /** Exchange prices captured for one league and provider day, kept beside the ESPN fixtures in fixtures/kalshi. */
  market(league: LeagueId, dateKey: string): Raw | null {
    return this.json(join('..', 'kalshi', `${league}-${dateKey}.json`));
  }

  /** Sportsbook lines recorded for one league and provider day, kept beside the ESPN fixtures in fixtures/lines. */
  lines(league: LeagueId, dateKey: string): Raw | null {
    return this.json(join('..', 'lines', `${league}-${dateKey}.json`));
  }
}

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function capturedContract(raw: unknown): CapturedContract | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  if (typeof r.ticker !== 'string' || !Array.isArray(r.candles)) return null;
  const candles = (r.candles as unknown[])
    .filter((c): c is unknown[] => Array.isArray(c) && finiteOrNull(c[0]) !== null)
    .map((c): PriceCandle => [c[0] as number, finiteOrNull(c[1]), finiteOrNull(c[2]), finiteOrNull(c[3])])
    .sort((a, b) => a[0] - b[0]);
  return candles.length ? { ticker: r.ticker, candles } : null;
}

/** Attaches the Kalshi prices captured for a game, when fixtures/kalshi has them. Only real replays call this. */
export function withCapturedMarket(fx: FixtureStore, tl: GameTimeline): GameTimeline {
  const scheduled = Date.parse(tl.event.date ?? tl.event.competitions?.[0]?.date);
  if (!Number.isFinite(scheduled)) return tl;
  let file: Raw | null;
  try {
    file = fx.market(tl.league, easternDateKey(new Date(scheduled)));
  } catch {
    // An unreadable capture leaves the replay without prices rather than stopping it.
    return tl;
  }
  const game = file?.games?.[tl.id] as Raw | undefined;
  if (!game || typeof game !== 'object') return tl;
  const home = capturedContract(game.home);
  const away = capturedContract(game.away);
  if (home || away) tl.market = { source: typeof file?.source === 'string' ? file.source : 'Kalshi', event: String(game.event ?? ''), home, away };
  return tl;
}

/** One recorded reading, refused rather than repaired when a field is not a number. */
function capturedPoint(raw: unknown): LinePoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  return {
    at: r.at,
    spreadHome: finiteOrNull(r.spreadHome),
    spreadAway: finiteOrNull(r.spreadAway),
    spreadOddsHome: finiteOrNull(r.spreadOddsHome),
    spreadOddsAway: finiteOrNull(r.spreadOddsAway),
    total: finiteOrNull(r.total),
    totalOddsOver: finiteOrNull(r.totalOddsOver),
    totalOddsUnder: finiteOrNull(r.totalOddsUnder),
    moneylineHome: finiteOrNull(r.moneylineHome),
    moneylineAway: finiteOrNull(r.moneylineAway),
  };
}

/**
 * The sportsbook line recorded while this game ran, if anybody was recording.
 *
 * Unlike the exchange's prices, which can be asked for after the fact, a book's
 * line can only be known for a game somebody watched: the provider reports an
 * opening line and a closing one, and its own movement collection is always
 * empty. A scenario with no recording simply replays without one.
 */
export function withCapturedLines(fx: FixtureStore, tl: GameTimeline): GameTimeline {
  const scheduled = Date.parse(tl.event.date ?? tl.event.competitions?.[0]?.date);
  if (!Number.isFinite(scheduled)) return tl;
  let file: Raw | null;
  try {
    file = fx.lines(tl.league, easternDateKey(new Date(scheduled)));
  } catch {
    // An unreadable recording leaves the replay without a line rather than stopping it.
    return tl;
  }
  const game = file?.games?.[tl.id] as Raw | undefined;
  const points = Array.isArray(game?.points) ? (game.points as unknown[]).map(capturedPoint).filter((p): p is LinePoint => p !== null) : [];
  if (!points.length) return tl;
  points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const captured: CapturedLines = { provider: typeof game?.provider === 'string' ? game.provider : (typeof file?.provider === 'string' ? file.provider : 'Sportsbook'), points };
  tl.lines = captured;
  return tl;
}

const MIN = 60_000;
const TEAM_STATS_NOTE = 'Team statistics appear when a game ends; intermediate totals were never captured.';

function timelines(fx: FixtureStore, league: LeagueId, events: Raw[], divisionsOf: (id: string) => Division[]): GameTimeline[] {
  const prefix = league === 'nfl' ? 'nfl' : 'cfb';
  return events.flatMap((e) => {
    const summary = fx.json(`summary/${prefix}-${e.id}.json`);
    return summary ? [buildTimeline(league, e, summary, divisionsOf(String(e.id)))] : [];
  });
}

function span(games: GameTimeline[]): { startAt: number; endAt: number } | null {
  const live = games.filter((g) => !g.scoreOnly);
  if (!live.length) return null;
  return { startAt: Math.min(...live.map((g) => g.kickoffAt)) - 5 * MIN, endAt: Math.max(...live.map((g) => g.endAt)) + 5 * MIN };
}

const firstQuarter = (tl: GameTimeline, period: number) => tl.plays.find((p) => Number(p.raw.period?.number) === period)?.t ?? tl.kickoffAt;

function singleGame(fx: FixtureStore, league: LeagueId, id: string, scoreboardRel: string, divisions: Division[]): GameTimeline | null {
  const event = (fx.json(scoreboardRel)?.events ?? []).find((e: Raw) => String(e.id) === id);
  const prefix = league === 'nfl' ? 'nfl' : 'cfb';
  const summary = fx.json(`summary/${prefix}-${id}.json`);
  return event && summary ? buildTimeline(league, event, summary, divisions) : null;
}

const dateKeyOf = (iso: string) => {
  const d = new Date(Date.parse(iso) - 5 * 60 * MIN); // provider days are US Eastern; a 5-hour shift is safe for afternoon and evening kickoffs
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

const BASE_GAME = { league: 'nfl' as const, id: '401872925', rel: 'scoreboard/nfl-20260913.json' }; // Tampa Bay at Cincinnati, 13 Sep 2026

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'nfl-week1-sunday',
    label: 'Replay · NFL Week 1, Sunday 13 Sep 2026',
    description: 'The real Sunday slate, replayed from the plays ESPN reported, on a sped-up clock. Nothing here is live.',
    synthetic: false,
    speed: 30,
    build(fx) {
      const events = fx.json('scoreboard/nfl-20260913.json')?.events ?? [];
      const games = timelines(fx, 'nfl', events, () => ['NFL']);
      const s = span(games);
      return s ? { date: '20260913', games, ...s, limitations: [TEAM_STATS_NOTE], outages: [] } : null;
    },
  },
  {
    id: 'college-week2-saturday',
    label: 'Replay · College football, Saturday 12 Sep 2026',
    description: 'Captured FBS, FCS and Division II games from one Saturday, replayed from their reported plays. Score-only games appear with their final result.',
    synthetic: false,
    speed: 45,
    build(fx) {
      const groups: Array<[Division, string]> = [['FBS', '80'], ['FCS', '81'], ['D2', '57'], ['D3', '58']];
      const membership = new Map<string, Division[]>();
      const events = new Map<string, Raw>();
      for (const [division, g] of groups) {
        for (const e of fx.json(`scoreboard/cfb-20260912-g${g}.json`)?.events ?? []) {
          const id = String(e.id);
          membership.set(id, [...(membership.get(id) ?? []), division]);
          if (!events.has(id)) events.set(id, e);
        }
      }
      const captured = [...events.values()].filter((e) => fx.json(`summary/cfb-${e.id}.json`));
      const games = timelines(fx, 'cfb', captured, (id) => membership.get(id) ?? ['FBS']);
      const s = span(games);
      return s
        ? { date: '20260912', games, ...s, outages: [], limitations: [TEAM_STATS_NOTE, 'Score-only games have no play-by-play, so they show their final result for the whole replay.', 'Only a sample of the day’s games was captured for the replay.'] }
        : null;
    },
  },
  {
    id: 'nfl-overtime',
    label: 'Replay · NFL overtime, Giants at Cowboys (14 Sep 2025)',
    description: 'A real NFL game decided in overtime, starting late in the fourth quarter.',
    synthetic: false,
    speed: 15,
    build(fx) {
      const tl = singleGame(fx, 'nfl', '401772834', 'scoreboard/event-nfl-401772834.json', ['NFL']);
      if (!tl) return null;
      return { date: dateKeyOf(tl.event.date), games: [tl], startAt: firstQuarter(tl, 4) - MIN, endAt: tl.endAt + 3 * MIN, limitations: [TEAM_STATS_NOTE], outages: [] };
    },
  },
  {
    id: 'college-overtime',
    label: 'Replay · College double overtime, Baylor at SMU (6 Sep 2025)',
    description: 'A real college game that went to a second overtime, where each possession must attempt a two-point try.',
    synthetic: false,
    speed: 15,
    build(fx) {
      const tl = singleGame(fx, 'cfb', '401754525', 'scoreboard/event-cfb-401754525.json', ['FBS']);
      if (!tl) return null;
      return { date: dateKeyOf(tl.event.date), games: [tl], startAt: firstQuarter(tl, 4) - MIN, endAt: tl.endAt + 3 * MIN, limitations: [TEAM_STATS_NOTE], outages: [] };
    },
  },
  {
    id: 'test-overturned-touchdown',
    label: 'Test scenario · Touchdown reversed on review (synthetic)',
    description: 'Built on a real game. One touchdown is deliberately reversed 60 seconds after it appears; later plays are withheld so the edit stays consistent. Not real events.',
    synthetic: true,
    speed: 4,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ['NFL']);
      if (!tl) return null;
      const i = tl.plays.findIndex((p) => /touchdown/i.test(p.raw.type?.text ?? '') && !/return/i.test(p.raw.type?.text ?? ''));
      if (i < 1) return null;
      const td = tl.plays[i];
      const before = tl.plays[i - 1].raw;
      const comps: Raw[] = tl.summary.header.competitions[0].competitors;
      const home = comps.find((c) => c.homeAway === 'home')?.team;
      const away = comps.find((c) => c.homeAway === 'away')?.team;
      if (!home || !away) return null;
      const offenseIsHome = String(td.raw.start?.team?.id) === String(home.id);
      const defense = offenseIsHome ? away : home;
      const passing = /passing/i.test(td.raw.type?.text ?? '');
      tl.edits.push({
        kind: 'revise',
        at: td.t + MIN,
        playId: String(td.raw.id),
        scoreDelta: { home: Number(before.homeScore) - Number(td.raw.homeScore), away: Number(before.awayScore) - Number(td.raw.awayScore) },
        patch: (raw) => ({
          ...raw,
          type: passing ? { id: '24', text: 'Pass Reception', abbreviation: 'REC' } : { id: '5', text: 'Rush', abbreviation: 'RUSH' },
          scoringPlay: false,
          text: `${raw.text} [Test scenario: after review the ball carrier was ruled down at the 1-yard line. No touchdown.]`,
          modified: new Date(td.t + MIN).toISOString(),
          end: {
            ...raw.end,
            down: 1,
            distance: 1,
            yardsToEndzone: 1,
            yardLine: offenseIsHome ? 99 : 1,
            possessionText: `${defense.abbreviation} 1`,
            downDistanceText: `1st & Goal at ${defense.abbreviation} 1`,
            shortDownDistanceText: '1st & Goal',
            team: { id: raw.start?.team?.id },
          },
        }),
      });
      const endAt = td.t + 4 * MIN;
      tl.edits.push({ kind: 'hold', from: td.t + 1, until: Number.POSITIVE_INFINITY });
      return { date: '20260913', games: [tl], startAt: td.t - 3 * MIN, endAt, limitations: ['Synthetic test scenario: the reversal did not happen in the real game.'], outages: [] };
    },
  },
  {
    id: 'test-delayed-burst',
    label: 'Test scenario · Delayed burst of plays (synthetic)',
    description: 'Built on a real game. Five consecutive plays are withheld and then delivered at once, as a lagging feed would. Not real timing.',
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ['NFL']);
      if (!tl) return null;
      const k = tl.plays.findIndex((p, idx) => idx > 20 && /rush|pass/i.test(p.raw.type?.text ?? ''));
      if (k < 0 || k + 5 >= tl.plays.length) return null;
      const from = tl.plays[k].t;
      const until = tl.plays[k + 5].t + 1;
      tl.edits.push({ kind: 'hold', from, until });
      return { date: '20260913', games: [tl], startAt: from - 2 * MIN, endAt: until + 4 * MIN, limitations: ['Synthetic test scenario: the provider did not really delay these plays.'], outages: [] };
    },
  },
  {
    id: 'test-missing-spot',
    label: 'Test scenario · Ball spot missing (synthetic)',
    description: 'Built on a real game. For several plays the feed omits where the ball is, so the field must say the spot is unavailable. Not real data loss.',
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ['NFL']);
      if (!tl) return null;
      const k = tl.plays.findIndex((p, idx) => idx > 40 && /rush|pass/i.test(p.raw.type?.text ?? ''));
      if (k < 0 || k + 8 >= tl.plays.length) return null;
      tl.edits.push({ kind: 'strip-spot', from: tl.plays[k].t, until: tl.plays[k + 8].t });
      return { date: '20260913', games: [tl], startAt: tl.plays[k].t - 2 * MIN, endAt: tl.plays[k + 8].t + 4 * MIN, limitations: ['Synthetic test scenario: the real feed reported these spots.'], outages: [] };
    },
  },
  {
    id: 'test-weather',
    label: 'Test scenario · Snow at the venue, at night (synthetic)',
    description: "Built on a real game, with the provider's weather at the venue replaced by snow after dark on a grass field. The real game was played in the dry. Not real weather.",
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ['NFL']);
      if (!tl) return null;
      /*
       * A way to see a sky, because no captured scenario has one: the weather at
       * a venue is on the live scoreboard and was not captured with these games.
       * Condition 44 is the provider's own id for snow after dark, one of the
       * night forms 33 to 44, so this is the shape a real report takes with
       * numbers that did not happen. Everything downstream, from how the field is
       * lit to what falls on it, reads it exactly as it reads a real one.
       */
      tl.event = { ...tl.event, weather: { conditionId: 44, temperature: 24, displayValue: 'Snow' } };
      const comp = tl.event.competitions[0];
      tl.event.competitions = [{ ...comp, venue: { ...comp.venue, indoor: false, grass: true } }];
      const k = Math.max(0, Math.floor(tl.plays.length * 0.3));
      return {
        date: '20260913',
        games: [tl],
        startAt: tl.plays[k].t - 2 * MIN,
        endAt: tl.plays[Math.min(tl.plays.length - 1, k + 40)].t + 4 * MIN,
        limitations: ['Synthetic test scenario: the provider reported no snow at this game.'],
        outages: [],
      };
    },
  },
  {
    id: 'test-indoors',
    label: 'Test scenario · A venue with a roof (synthetic)',
    description: 'Built on a real game, with the venue reported as indoors on a synthetic surface. The real game was played outdoors on grass. Not a real venue report.',
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ['NFL']);
      if (!tl) return null;
      /*
       * A way to see a roof. Whether a venue has one is reported on the live
       * scoreboard and on the venue's own document, and neither was captured
       * with these games, so no real replay has an indoor venue in it. The flag
       * here is the one the provider sends, read by exactly the same code.
       */
      const comp = tl.event.competitions[0];
      tl.event = { ...tl.event, weather: undefined, competitions: [{ ...comp, venue: { ...comp.venue, indoor: true, grass: false } }] };
      const k = Math.max(0, Math.floor(tl.plays.length * 0.3));
      return {
        date: '20260913',
        games: [tl],
        startAt: tl.plays[k].t - 2 * MIN,
        endAt: tl.plays[Math.min(tl.plays.length - 1, k + 40)].t + 4 * MIN,
        limitations: ['Synthetic test scenario: this venue is outdoors and has a grass field.'],
        outages: [],
      };
    },
  },
  {
    id: 'test-provider-outage',
    label: 'Test scenario · Provider outage and recovery (synthetic)',
    description: 'Built on real games. The provider stops answering for two minutes of replay time, then recovers. Not a real outage.',
    synthetic: true,
    speed: 20,
    build(fx) {
      const events = (fx.json('scoreboard/nfl-20260913.json')?.events ?? []).slice(0, 4);
      const games = timelines(fx, 'nfl', events, () => ['NFL']);
      const s = span(games);
      if (!s) return null;
      const startAt = s.startAt + 60 * MIN;
      return { date: '20260913', games, startAt, endAt: startAt + 30 * MIN, limitations: ['Synthetic test scenario: the outage is simulated.'], outages: [{ from: startAt + 3 * MIN, until: startAt + 5 * MIN }] };
    },
  },
  {
    id: 'test-lateral-position',
    label: 'Test scenario · Lateral ball position (synthetic)',
    description: 'Built on a real game. Where the ball sits across the field is estimated from each play description (left, middle or right) to show lateral positioning on the fields. No feed reports these positions. Not real data.',
    synthetic: true,
    speed: 6,
    build(fx) {
      const tl = singleGame(fx, BASE_GAME.league, BASE_GAME.id, BASE_GAME.rel, ['NFL']);
      if (!tl) return null;
      const k = tl.plays.findIndex((p, idx) => idx > 30 && /rush|pass/i.test(p.raw.type?.text ?? ''));
      if (k < 0 || k + 24 >= tl.plays.length) return null;
      tl.edits.push({ kind: 'synthetic-lateral' });
      return {
        date: '20260913',
        games: [tl],
        startAt: tl.plays[k].t - 2 * MIN,
        endAt: tl.plays[k + 24].t + 4 * MIN,
        limitations: ['Synthetic test scenario: lateral positions are estimated from play descriptions. No feed reported them.'],
        outages: [],
      };
    },
  },
];
