import { describe, expect, it } from 'vitest';
import { logoAt, logoPixels } from '../shared/logo';

const NFL = 'https://a.espncdn.com/i/teamlogos/nfl/500/cle.png';
const DARK = 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/nyj.png';
const NCAA = 'https://a.espncdn.com/i/teamlogos/ncaa/500/194.png';

describe('logo sizing', () => {
  it('asks the provider for the size it is about to draw', () => {
    expect(logoAt(NFL, 56)).toBe('https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/cle.png&w=64&h=64');
    expect(logoAt(NFL, 64)).toContain('w=64&h=64');
    expect(logoAt(NFL, 65)).toContain('w=128&h=128');
  });

  it('keeps the dark variant distinct, because the provider does', () => {
    expect(logoAt(DARK, 30)).toContain('/i/teamlogos/nfl/500-dark/nyj.png');
    expect(logoAt(DARK, 30)).not.toBe(logoAt(NFL, 30));
  });

  it('answers for college as well as professional', () => {
    expect(logoAt(NCAA, 26)).toBe('https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/194.png&w=32&h=32');
  });

  it('leaves anything that is not a provider team logo exactly as it came', () => {
    for (const other of ['https://example.com/logo.png', '/local/logo.svg', 'https://a.espncdn.com/i/venues/12345.jpg', 'data:image/png;base64,AAAA']) {
      expect(logoAt(other, 40)).toBe(other);
    }
  });

  it('never rewrites a logo it has already rewritten', () => {
    const once = logoAt(NFL, 40)!;
    expect(logoAt(once, 40)).toBe(once);
  });

  it('asks for nothing at all when the provider gave no logo', () => {
    expect(logoAt(null, 40)).toBeNull();
    expect(logoAt(undefined, 40)).toBeNull();
    expect(logoAt('', 40)).toBeNull();
  });

  it('leaves the original alone rather than asking for a size that is bigger than it', () => {
    // Measured: the combiner at 512 scales the 500 source up and returns 164 kB against the original's 94.
    expect(logoAt(NFL, 257)).toBe(NFL);
    expect(logoAt(NFL, 512)).toBe(NFL);
    expect(logoAt(NFL, 900)).toBe(NFL);
    expect(logoAt(NFL, 256)).toContain('w=256&h=256');
  });

  it('drops a query the provider put there rather than stacking one on it', () => {
    expect(logoAt(`${NFL}?w=110&h=110`, 26)).toBe('https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/cle.png&w=32&h=32');
  });

  it('asks for twice the drawn size on a retina screen, and never more than twice', () => {
    expect(logoPixels(56, 1)).toBe(56);
    expect(logoPixels(56, 2)).toBe(112);
    expect(logoPixels(56, 3)).toBe(112);
    expect(logoPixels(56, 0.5)).toBe(56);
  });
});
