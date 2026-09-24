import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyDetailDelta, computeDetailDelta } from '../shared/detailDelta';
import { MAX_LINE_POINTS, lineAtPlay, lineHeading, linePointFrom, lineTrack, recordLine, sameLine, sameLineHistory } from '../shared/lineHistory';
import type { BettingLines, GameDetail, LineHistory, LinePoint } from '../shared/model';
import type { PlayFrame } from '../shared/replayFrames';
import { OddsPanel } from '../src/views/detail/OddsPanel';
import { bettingLines, game } from './helpers/builders';

// Fictional lines and times; the field names and shapes are the provider's and Gridiron's own.
const at = (hhmm: string) => `2026-09-13T${hhmm}:00.000Z`;

/** A provider reading: home spread and its price, total, and both moneylines. */
function lines(spread: number | null, total: number | null, home: number | null, away: number | null): BettingLines {
  const price = (line: number, odds: number) => ({ open: null, latest: { line, odds } });
  return {
    provider: 'Book',
    favorite: spread !== null && spread < 0 ? 'home' : 'away',
    details: null,
    overUnder: total,
    spread: spread === null ? null : { home: price(spread, -110), away: price(-spread, -110) },
    total: total === null ? null : { over: price(total, -110), under: price(total, -110) },
    moneyline: home === null && away === null ? null : { home: { open: null, latest: home }, away: { open: null, latest: away } },
  } as BettingLines;
}

function detailWith(lineHistory: LineHistory | null, plays: Array<{ id: string; wallclock: string | null }>): GameDetail {
  return {
    gameId: 'nfl-1',
    summary: {} as GameDetail['summary'],
    drives: [],
    plays: plays.map((p, order) => ({ ...p, order })) as GameDetail['plays'],
    scoring: [],
    stats: [],
    leaders: [],
    attendance: null,
    currentDriveId: null,
    gaps: [],
    lineHistory,
  };
}

describe('reading a line', () => {
  it('takes both sides of every market, so the record can reproduce the table', () => {
    const point = linePointFrom(lines(-3.5, 47.5, -180, 155), at('17:00'));
    expect(point).toEqual({
      at: at('17:00'),
      spreadHome: -3.5,
      spreadAway: 3.5,
      spreadOddsHome: -110,
      spreadOddsAway: -110,
      total: 47.5,
      totalOddsOver: -110,
      totalOddsUnder: -110,
      moneylineHome: -180,
      moneylineAway: 155,
    });
  });

  it('is not a reading when the book quoted nothing', () => {
    expect(linePointFrom(lines(null, null, null, null), at('17:00'))).toBeNull();
    expect(linePointFrom(null, at('17:00'))).toBeNull();
    expect(linePointFrom(undefined, at('17:00'))).toBeNull();
  });
});

describe('keeping the record', () => {
  it('writes the first reading down', () => {
    const history = recordLine(null, lines(-3.5, 47.5, -180, 155), at('17:00'));
    expect(history?.provider).toBe('Book');
    expect(history?.points).toHaveLength(1);
    expect(history?.captured).toBe(false);
  });

  it('returns the very same record when the line did not move, so nothing downstream re-runs', () => {
    const first = recordLine(null, lines(-3.5, 47.5, -180, 155), at('17:00'))!;
    const again = recordLine(first, lines(-3.5, 47.5, -180, 155), at('17:01'));
    expect(again).toBe(first);
  });

  it('writes a new point when any one figure moved, including the juice', () => {
    const first = recordLine(null, lines(-3.5, 47.5, -180, 155), at('17:00'))!;
    const moved = recordLine(first, lines(-3, 47.5, -180, 155), at('17:05'))!;
    expect(moved.points).toHaveLength(2);
    const juice = { ...lines(-3, 47.5, -180, 155) };
    juice.spread!.home.latest!.odds = -120;
    expect(recordLine(moved, juice, at('17:06'))!.points).toHaveLength(3);
  });

  it('keeps a record with nothing in it rather than inventing one, when the book goes quiet', () => {
    const first = recordLine(null, lines(-3.5, 47.5, -180, 155), at('17:00'))!;
    expect(recordLine(first, null, at('17:10'))).toBe(first);
    expect(recordLine(null, null, at('17:10'))).toBeNull();
  });

  it('drops the oldest points rather than growing without bound', () => {
    let history: LineHistory | null = null;
    for (let i = 0; i < MAX_LINE_POINTS + 20; i++) history = recordLine(history, lines(-3.5 - i * 0.5, 47.5, -180, 155), at('17:00'));
    expect(history!.points).toHaveLength(MAX_LINE_POINTS);
    expect(history!.points[0].spreadHome).toBe(-3.5 - 20 * 0.5);
  });

  it('compares two records by their provider, length and latest reading', () => {
    const a = recordLine(null, lines(-3.5, 47.5, -180, 155), at('17:00'))!;
    const b = recordLine(null, lines(-3.5, 47.5, -180, 155), at('17:30'))!;
    expect(sameLineHistory(a, b)).toBe(true);
    expect(sameLineHistory(a, recordLine(a, lines(-3, 47.5, -180, 155), at('17:05')))).toBe(false);
    expect(sameLineHistory(null, null)).toBe(true);
    expect(sameLineHistory(a, null)).toBe(false);
  });

  it('holds two readings the same only when every figure matches', () => {
    const one = linePointFrom(lines(-3.5, 47.5, -180, 155), at('17:00'));
    const two = linePointFrom(lines(-3.5, 47.5, -180, 155), at('18:00'));
    expect(sameLine(one, two)).toBe(true);
    expect(sameLine(one, linePointFrom(lines(-3.5, 48, -180, 155), at('18:00')))).toBe(false);
    expect(sameLine(one, null)).toBe(false);
    expect(sameLine(null, null)).toBe(true);
  });
});

describe('the line at a play', () => {
  const history: LineHistory = {
    provider: 'Book',
    captured: false,
    points: [
      { at: at('16:00'), spreadHome: -3.5, spreadAway: 3.5, spreadOddsHome: -110, spreadOddsAway: -110, total: 47.5, totalOddsOver: -110, totalOddsUnder: -110, moneylineHome: -180, moneylineAway: 155 },
      { at: at('17:05'), spreadHome: -6.5, spreadAway: 6.5, spreadOddsHome: -110, spreadOddsAway: -110, total: 45.5, totalOddsOver: -110, totalOddsUnder: -110, moneylineHome: -260, moneylineAway: 215 },
    ] as LinePoint[],
  };
  const plays = [
    { id: 'nfl-1:1', wallclock: at('17:00') },
    { id: 'nfl-1:2', wallclock: at('17:10') },
    { id: 'nfl-1:3', wallclock: at('17:20') },
  ];

  it('gives the last reading taken at or before the play, never one taken after it', () => {
    const detail = detailWith(history, plays);
    expect(lineAtPlay(detail, 'nfl-1:1')!.point.spreadHome).toBe(-3.5);
    expect(lineAtPlay(detail, 'nfl-1:2')!.point.spreadHome).toBe(-6.5);
    expect(lineAtPlay(detail, 'nfl-1:3')!.point.spreadHome).toBe(-6.5);
  });

  it('says how stale the reading was, and what stood at the play before', () => {
    const detail = detailWith(history, plays);
    const second = lineAtPlay(detail, 'nfl-1:2')!;
    expect(second.ageSeconds).toBe(300);
    expect(second.before!.spreadHome).toBe(-3.5);
    // The line did not move between the second play and the third, so there is nothing to show as a move.
    expect(lineAtPlay(detail, 'nfl-1:3')!.before).toBeNull();
    expect(lineAtPlay(detail, 'nfl-1:1')!.before).toBeNull();
  });

  it('has nothing to say about a play before the record starts, or one with no time on it', () => {
    expect(lineAtPlay(detailWith(history, [{ id: 'nfl-1:0', wallclock: at('15:00') }]), 'nfl-1:0')).toBeNull();
    expect(lineAtPlay(detailWith(history, [{ id: 'nfl-1:0', wallclock: null }]), 'nfl-1:0')).toBeNull();
    expect(lineAtPlay(detailWith(null, plays), 'nfl-1:1')).toBeNull();
    expect(lineAtPlay(detailWith(history, plays), 'nfl-1:9')).toBeNull();
  });
});

describe('carrying the record to clients', () => {
  const plays = [{ id: 'nfl-1:1', wallclock: at('17:00') }];

  it('is left out of a delta when it did not change, and rebuilt when it did', () => {
    const one = recordLine(null, lines(-3.5, 47.5, -180, 155), at('17:00'))!;
    const before = detailWith(one, plays);
    expect(computeDetailDelta(before, detailWith(one, plays), 1, 2).lineHistory).toBeUndefined();

    const two = recordLine(one, lines(-6.5, 45.5, -260, 215), at('17:05'))!;
    const delta = computeDetailDelta(before, detailWith(two, plays), 1, 2);
    expect(delta.lineHistory!.points).toHaveLength(2);
    expect(applyDetailDelta(before, delta)!.lineHistory!.points[1].spreadHome).toBe(-6.5);
  });
});

describe('what the block says it is showing', () => {
  const state = { inspecting: false, recorded: false, replay: false, final: false, live: false };
  const at = (ageSeconds: number) => ({ provider: 'Book', ageSeconds, point: {} as LinePoint, before: null });

  it('says how stale the reading was when there is one at the play', () => {
    expect(lineHeading(at(10), { ...state, inspecting: true, recorded: true })).toBe('As reported moments before this play');
    expect(lineHeading(at(300), { ...state, inspecting: true, recorded: true })).toBe('As reported 5 min before this play');
    expect(lineHeading(at(3_600), { ...state, inspecting: true, recorded: true })).toBe('As reported an hour before this play');
    expect(lineHeading(at(10_800), { ...state, inspecting: true, recorded: true })).toBe('As reported 3 hours before this play');
  });

  it('tells a gap in this game\'s record apart from a game no record was kept for', () => {
    expect(lineHeading(null, { ...state, inspecting: true, recorded: true })).toBe('No line recorded at this play');
    expect(lineHeading(null, { ...state, inspecting: true, recorded: false })).toBe('Opening and closing lines, not play by play');
  });

  it('describes the live table when no play is being looked at', () => {
    expect(lineHeading(null, { ...state, replay: true, final: true })).toBe('Closing lines, as captured');
    // With a recording, a replay is showing the line that stood then, not the one it closed at.
    expect(lineHeading(null, { ...state, replay: true, final: true, recorded: true })).toBe('As recorded, at the replay clock');
    expect(lineHeading(null, { ...state, final: true })).toBe('Closing lines');
    expect(lineHeading(null, { ...state, live: true })).toBe('Latest lines reported');
    expect(lineHeading(null, state)).toBe('Current lines');
  });
});

describe('the sportsbook block on the page', () => {
  const history: LineHistory = {
    provider: 'Book',
    captured: false,
    points: [
      { at: at('16:00'), spreadHome: -3.5, spreadAway: 3.5, spreadOddsHome: -110, spreadOddsAway: -110, total: 47.5, totalOddsOver: -110, totalOddsUnder: -110, moneylineHome: -180, moneylineAway: 155 },
      { at: at('17:05'), spreadHome: -6.5, spreadAway: 6.5, spreadOddsHome: -115, spreadOddsAway: -105, total: 45.5, totalOddsOver: -110, totalOddsUnder: -110, moneylineHome: -260, moneylineAway: 215 },
    ] as LinePoint[],
  };
  const plays = [
    { id: 'nfl-1:1', wallclock: at('17:00') },
    { id: 'nfl-1:2', wallclock: at('17:10') },
  ];
  const summary = game({ id: 'nfl-1', lines: bettingLines(-6.5, 45.5, -260, 215) });
  const render = (playId: string | null) => {
    const detail = { ...detailWith(history, plays), summary };
    const frame = playId === null ? null : ({ play: detail.plays.find((p) => p.id === playId)!, index: 0, total: 2, drive: null, situation: null, fromYard: null, toYard: null, score: { home: 0, away: 0 } } as PlayFrame);
    return renderToStaticMarkup(createElement(OddsPanel, { game: summary, detail, frame, replay: false }));
  };

  it('rewinds to the line that stood at the play, with what it had been before', () => {
    const html = render('nfl-1:2');
    expect(html).toContain('As reported 5 min before this play');
    // A true minus sign, the same one the live table writes odds with.
    expect(html).toContain('\u22126.5 \u2212115');
    expect(html).toContain('Was \u22123.5 \u2212110');
    expect(html).toContain('+6.5 \u2212105');
    expect(html).toContain('+215');
    expect(html).toContain('Was +155');
    expect(html).toContain('O 45.5 \u2212110');
    expect(html).toContain('Was O 47.5 \u2212110');
    // The open-and-latest table belongs to the live view; while rewound it is not on the page.
    expect(html).not.toContain('Open ');
  });

  it('shows the first reading with nothing before it, because there was nothing before it', () => {
    const html = render('nfl-1:1');
    expect(html).toContain('As reported an hour before this play');
    expect(html).toContain('\u22123.5 \u2212110');
    expect(html).not.toContain('Was ');
  });

  it('shows the book\'s own opening and latest line when no play is being looked at', () => {
    const html = render(null);
    expect(html).toContain('Latest lines reported');
    expect(html).not.toContain('this play');
  });

  it('draws how the line moved, with a mark for each reading the book posted', () => {
    const html = render(null);
    expect(html).toContain('odds-spark-line');
    // Two readings in this record, so two marks, and the step line holds to the right edge.
    expect(html.match(/odds-spark-step/g)).toHaveLength(2);
    expect(html).toContain('HOM by');
    expect(html).toContain('3 toward HOM');
  });

  it('stops the trend at the play being looked at, so the block is one moment', () => {
    // At the first play only one reading has been taken, and one reading is a line and not a movement.
    expect(render('nfl-1:1')).not.toContain('odds-spark-line');
    expect(render('nfl-1:2')).toContain('odds-spark-line');
  });

  it("calls a spread of zero a pick'em rather than a team favoured by nothing", () => {
    const pk: LineHistory = {
      provider: 'Book',
      captured: false,
      points: [
        { ...history.points[0], spreadHome: -3, spreadAway: 3 },
        { ...history.points[1], spreadHome: 0, spreadAway: 0 },
      ] as LinePoint[],
    };
    const detail = { ...detailWith(pk, plays), summary };
    const html = renderToStaticMarkup(createElement(OddsPanel, { game: summary, detail, frame: null, replay: false }));
    expect(html).toContain('Pick&#x27;em');
    expect(html).toContain('3 toward AWY');
    expect(html).not.toContain('by</span> <span');
  });

  it('stops marking every reading once they would be a smear, because the step line already turns at each one', () => {
    const many: LineHistory = {
      provider: 'Book',
      captured: false,
      points: Array.from({ length: 40 }, (_, i) => ({ ...history.points[0], at: `2026-09-13T${String(12 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00.000Z`, spreadHome: -3.5 - i * 0.5 })) as LinePoint[],
    };
    const detail = { ...detailWith(many, plays), summary };
    const html = renderToStaticMarkup(createElement(OddsPanel, { game: summary, detail, frame: null, replay: false }));
    expect(html).toContain('odds-spark-line');
    expect(html).not.toContain('odds-spark-step');
  });

  it('never colours a line move up or down, because a spread moving is a direction and not a verdict', () => {
    const html = render(null);
    expect(html).toContain('odds-move');
    expect(html).not.toContain('odds-move is-up');
    expect(html).not.toContain('odds-move is-down');
  });

  it('draws no trend at all for a game nothing was recording, rather than a flat one', () => {
    const detail = { ...detailWith(null, plays), summary };
    const html = renderToStaticMarkup(createElement(OddsPanel, { game: summary, detail, frame: null, replay: false }));
    expect(html).toContain('Latest lines reported');
    expect(html).not.toContain('odds-spark');
  });
});

describe('how one figure moved across the record', () => {
  const history: LineHistory = {
    provider: 'Book',
    captured: false,
    points: [
      { at: at('16:00'), spreadHome: -3.5, spreadAway: 3.5, spreadOddsHome: -110, spreadOddsAway: -110, total: 47.5, totalOddsOver: -110, totalOddsUnder: -110, moneylineHome: -180, moneylineAway: 155 },
      { at: at('17:05'), spreadHome: -6.5, spreadAway: 6.5, spreadOddsHome: -115, spreadOddsAway: -105, total: 47.5, totalOddsOver: -110, totalOddsUnder: -110, moneylineHome: -260, moneylineAway: 215 },
      { at: at('18:10'), spreadHome: -10.5, spreadAway: 10.5, spreadOddsHome: -110, spreadOddsAway: -110, total: 47.5, totalOddsOver: -110, totalOddsUnder: -110, moneylineHome: -600, moneylineAway: 440 },
    ] as LinePoint[],
  };

  it('is the readings of that figure, with where it started and where it ended', () => {
    const track = lineTrack(history, 'spreadHome')!;
    expect(track.points).toHaveLength(3);
    expect(track.first).toBe(-3.5);
    expect(track.last).toBe(-10.5);
    expect(track.change).toBe(-7);
  });

  it('stops where it is told to, so a trend under a play does not run past it', () => {
    expect(lineTrack(history, 'spreadHome', Date.parse(at('17:30')))!.points).toHaveLength(2);
    expect(lineTrack(history, 'spreadHome', Date.parse(at('16:30')))).toBeNull();
  });

  it('is nothing at all when the figure never moved, because a flat trend claims a movement', () => {
    // The total held at 47.5 through every reading while the spread ran away.
    expect(lineTrack(history, 'total')).toBeNull();
  });

  it('is nothing with fewer than two readings, or no record', () => {
    expect(lineTrack({ ...history, points: history.points.slice(0, 1) }, 'spreadHome')).toBeNull();
    expect(lineTrack(null, 'spreadHome')).toBeNull();
  });
});
