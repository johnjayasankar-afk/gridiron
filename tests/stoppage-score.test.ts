import { describe, expect, it } from 'vitest';
import { newDiagnostics, normalizeSummary } from '../server/providers/espn/normalize';
import { fixture } from './helpers/fixtures';

interface RawSummary {
  drives: { previous: Array<{ plays: Array<{ id: string; awayScore: number; homeScore: number }> }> };
}

describe('scores reported on stoppages', () => {
  it('keeps the score when the feed reports a two-minute warning as 0-0', () => {
    const raw = fixture<RawSummary>('summary/nfl-401872661.json');
    const rawWarning = raw.drives.previous.flatMap((d) => d.plays).find((p) => p.id === '4018726614809');
    // The captured provider quirk this guards against.
    expect([rawWarning?.awayScore, rawWarning?.homeScore]).toEqual([0, 0]);

    const detail = normalizeSummary(raw, 'nfl', ['NFL'], newDiagnostics());
    expect(detail).not.toBeNull();
    const plays = detail!.plays;
    const index = plays.findIndex((p) => p.providerId === '4018726614809');
    const warning = plays[index];
    expect(warning.kind).toBe('two_minute_warning');
    const previous = plays
      .slice(0, index)
      .reverse()
      .find((p) => p.scoreAfter.home !== null && p.scoreAfter.away !== null);
    expect(warning.scoreAfter).toEqual(previous?.scoreAfter);
    expect((warning.scoreAfter.home ?? 0) + (warning.scoreAfter.away ?? 0)).toBeGreaterThan(0);
  });
});
