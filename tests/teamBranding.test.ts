import { describe, expect, it } from 'vitest';
import { mergeTeam } from '../shared/situation';
import { team } from './helpers/builders';

/**
 * The provider does not put the same fields on a team in every payload. A
 * scoreboard carries no logo variants at all; the richer reports carry a dark
 * one. Taking the newest team wholesale meant each poll erased what the other
 * had found, and a logo flicked between its two addresses every few seconds,
 * reloading the image each time and flashing the disc it used to sit on.
 */
describe('a team across reports', () => {
  const rich = { ...team('NYG'), logo: 'https://x/500/nyg.png', logoDark: 'https://x/500-dark/nyg.png', color: '#0b2265', location: 'New York', conferenceId: 'nfc-east' };
  const bare = { ...team('NYG'), logo: 'https://x/500/scoreboard/nyg.png', logoDark: null, color: null, location: null, conferenceId: null };

  it('keeps branding a newer report did not carry', () => {
    const merged = mergeTeam(rich, bare);
    expect(merged.logoDark, 'the dark logo survives a report without one').toBe(rich.logoDark);
    expect(merged.color).toBe(rich.color);
    expect(merged.location).toBe('New York');
    expect(merged.conferenceId).toBe('nfc-east');
    // The newer report's own values still win where it has them.
    expect(merged.logo).toBe(bare.logo);
  });

  it('lets a newer report replace branding it does carry', () => {
    const rebrand = { ...rich, logoDark: 'https://x/500-dark/new.png', color: '#123456' };
    expect(mergeTeam(rich, rebrand)).toMatchObject({ logoDark: 'https://x/500-dark/new.png', color: '#123456' });
  });

  it('never keeps a rank or a record, which are not branding', () => {
    // A team can fall out of the rankings, and a report saying so must be able to.
    const ranked = { ...rich, rank: 7, record: '5-0' };
    const unranked = { ...rich, rank: null, record: null };
    expect(mergeTeam(ranked, unranked)).toMatchObject({ rank: null, record: null });
  });

  it('does not merge two different teams', () => {
    const other = team('DAL');
    expect(mergeTeam(rich, other)).toBe(other);
  });

  it('returns the newer team itself when nothing was left out, so nothing downstream re-renders', () => {
    expect(mergeTeam(rich, rich)).toBe(rich);
    const moved = { ...rich, rank: 3 };
    expect(mergeTeam(rich, moved)).toBe(moved);
  });
});
