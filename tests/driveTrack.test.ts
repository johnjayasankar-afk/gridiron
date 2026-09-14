import { describe, expect, it } from 'vitest';
import { describeDrive, driveStats, driveTrack, hasDrivePosition } from '../shared/driveTrack';
import type { Drive, DriveEdge, GameDetail } from '../shared/model';
import { detail, game, play, situation, spot } from './helpers/builders';

const edge = (progress: number, offense: 'home' | 'away', label: string | null = null): DriveEdge => ({ period: 1, clock: '12:00', label, spot: spot(progress, offense) });

function withDrive(d: GameDetail, patch: Partial<Drive>): GameDetail {
  return { ...d, drives: [{ ...d.drives[0], ...patch }] };
}

describe('driveTrack', () => {
  it('returns null when the provider reports no drives or plays', () => {
    const g = game();
    const d = { ...detail(g, []), drives: [], currentDriveId: null };
    expect(driveTrack(d)).toBeNull();
    expect(hasDrivePosition(driveTrack(d))).toBe(false);
  });

  it('tracks the current drive from reported spots and the live situation', () => {
    const g = game();
    const plays = [play({ n: 1, startProgress: 25, endProgress: 31, yards: 6 }), play({ n: 2, startProgress: 31, endProgress: 45, yards: 14, down: 2, distance: 4 })];
    const d = withDrive(detail(g, plays), { start: edge(25, 'away', 'AWY 25'), offensivePlays: 2, yards: 20, timeElapsed: '1:12' });
    const track = driveTrack(d, { situation: situation({ possession: 'away', progress: 45, down: 1, distance: 10 }) });
    expect(track).not.toBeNull();
    expect(track).toMatchObject({ offense: 'away', direction: 1, start: 25, startLabel: 'AWY 25', ball: 45, ballSource: 'live', lineToGain: 55, goalToGo: false, inProgress: true, playCount: 2, yards: 20, yardsSource: 'reported' });
    expect(track!.plays.map((p) => [p.from, p.to, p.gain, p.tone])).toEqual([
      [25, 31, 6, 'gain'],
      [31, 45, 14, 'gain'],
    ]);
    expect(track!.plays[1].downDistance).toBe('2nd & 4');
    expect(driveStats(track!)).toEqual(['2 plays', '20 yds', '1:12']);
    expect(hasDrivePosition(track)).toBe(true);
  });

  it('mirrors a home drive and measures yards between reported spots when no total is reported', () => {
    const live = situation({ possession: 'home', progress: 40 });
    const g = game({ situation: live });
    const plays = [play({ n: 1, offense: 'home', startProgress: 20, endProgress: 32 }), play({ n: 2, offense: 'home', startProgress: 32, endProgress: 40 })];
    const d = withDrive(detail(g, plays), { offense: 'home', offensivePlays: null, yards: null });
    const track = driveTrack(d, { situation: live })!;
    expect(track).toMatchObject({ direction: -1, start: 80, ball: 60, lineToGain: 50, yards: 20, yardsSource: 'spots', playCount: 2 });
    expect(track.plays.map((p) => p.gain)).toEqual([12, 8]);
  });

  it('leaves unreported spots empty instead of guessing', () => {
    const g = game({ situation: null });
    const plays = [play({ n: 1, startProgress: 25, endProgress: 30 }), play({ n: 2, startProgress: null, endProgress: null })];
    const track = driveTrack(detail(g, plays))!;
    expect(track.plays[1]).toMatchObject({ from: null, to: null, gain: null, tone: 'unknown' });
    expect(track).toMatchObject({ unspotted: 1, ball: 30, ballSource: 'play', lineToGain: null });
  });

  it('does not give away the rest of the drive during a replay', () => {
    const g = game();
    const plays = [
      play({ n: 1, startProgress: 25, endProgress: 35, yards: 10 }),
      play({ n: 2, startProgress: 35, endProgress: 100, yards: 65, kind: 'touchdown_pass', scoring: true, scoringTeam: 'away', away: 6 }),
    ];
    const d = withDrive(detail(g, plays), { start: edge(25, 'away'), result: 'TD', isScore: true, offensivePlays: 2, yards: 75, timeElapsed: '0:48', isCurrent: false });
    const cut = driveTrack(d, { upToOrder: 1 })!;
    expect(cut.plays).toHaveLength(1);
    expect(cut).toMatchObject({ result: null, isScore: false, yards: 10, yardsSource: 'spots', timeElapsed: null, inProgress: true, playCount: 1 });
    const full = driveTrack(d)!;
    expect(full).toMatchObject({ result: 'Touchdown', isScore: true, yards: 75, inProgress: false, lineToGain: null, ball: 100 });
    expect(full.plays[1].tone).toBe('score');
  });

  it('keeps the live spot out of a drive once possession has changed', () => {
    const live = situation({ possession: 'home', progress: 30 });
    const track = driveTrack(detail(game({ situation: live }), [play({ n: 1, startProgress: 40, endProgress: 45, yards: 5 })]), { situation: live })!;
    expect(track).toMatchObject({ ball: 45, ballSource: 'play' });
  });

  it('targets the goal line when it is goal to go', () => {
    const plays = [play({ n: 1, startProgress: 88, endProgress: 94, yards: 6 })];
    const track = driveTrack(detail(game(), plays), { situation: situation({ possession: 'away', progress: 94, down: 2, distance: 6, goalToGo: true }) })!;
    expect(track).toMatchObject({ lineToGain: null, goalToGo: true, ball: 94 });
  });

  it('classifies plays from reported types and flags only', () => {
    const plays = [
      play({ n: 1, kind: 'kickoff', offense: 'home', startProgress: 35, endProgress: 25, endOffense: 'away' }),
      play({ n: 2, startProgress: 25, endProgress: 20, yards: -5, kind: 'penalty', penalty: true }),
      play({ n: 3, startProgress: 20, endProgress: 18, yards: -2, kind: 'sack' }),
      play({ n: 4, startProgress: 18, endProgress: 18, yards: 0, kind: 'pass_incomplete' }),
      play({ n: 5, startProgress: 18, endProgress: 70, endOffense: 'home', kind: 'interception', turnover: true }),
    ];
    const track = driveTrack(withDrive(detail(game(), plays), { offensivePlays: null }))!;
    expect(track.plays.map((p) => p.tone)).toEqual(['kick', 'penalty', 'loss', 'even', 'turnover']);
    expect(track.plays[0]).toMatchObject({ from: 65, to: 25, gain: null });
    expect(track).toMatchObject({ playCount: 3, start: 25, inProgress: false, yards: null });
  });

  it('marks points scored by the defense as conceded', () => {
    const plays = [play({ n: 1, startProgress: 3, endProgress: 0, kind: 'safety', scoring: true, scoringTeam: null, home: 2 })];
    expect(driveTrack(detail(game(), plays))!.plays[0].tone).toBe('conceded');
  });

  it('describes the drive in a sentence', () => {
    const g = game();
    const d = withDrive(detail(g, [play({ n: 1, startProgress: 25, endProgress: 31, yards: 6 })]), { start: edge(25, 'away', 'AWY 25'), offensivePlays: 1, yards: 6 });
    expect(describeDrive(driveTrack(d)!, g)).toBe('AWY drive in progress: 1 play, 6 yards, from AWY 25.');
    const ended = withDrive(d, { result: 'PUNT', isCurrent: false });
    expect(describeDrive(driveTrack({ ...ended, currentDriveId: null })!, g)).toBe('AWY drive ended, punt: 1 play, 6 yards, from AWY 25.');
  });
});
