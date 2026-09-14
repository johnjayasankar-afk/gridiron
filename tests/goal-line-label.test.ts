import { describe, expect, it } from 'vitest';
import { labelFromProgress } from '../shared/field';

const teams = { home: { abbreviation: 'NE' }, away: { abbreviation: 'BUF' } };

describe('spot labels at the goal lines', () => {
  it('names the goal line instead of a zero yard line', () => {
    expect(labelFromProgress(100, 'away', teams)).toBe('NE goal line');
    expect(labelFromProgress(0, 'away', teams)).toBe('BUF goal line');
    expect(labelFromProgress(100, 'home', teams)).toBe('BUF goal line');
    expect(labelFromProgress(1, 'home', teams)).toBe('NE 1');
    expect(labelFromProgress(99, 'away', teams)).toBe('NE 1');
  });
});
