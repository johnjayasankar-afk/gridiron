import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, reloadForMissingChunk } from '../src/lib/chunks';

const MISSING = new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/TeamView-abc.js');

describe('missing code chunks', () => {
  let store: Map<string, string>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new Map();
    reload = vi.fn();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('window', { location: { reload } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognizes the errors Chrome, Safari and Firefox raise for a missing module', () => {
    expect(isChunkLoadError(MISSING)).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads once for a missing chunk, not again within ten minutes, and again after that', () => {
    const t = 1_000_000;
    expect(reloadForMissingChunk(MISSING, t)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForMissingChunk(MISSING, t + 60_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForMissingChunk(MISSING, t + 10 * 60_000 + 1)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads for other errors, or when session storage is unavailable', () => {
    expect(reloadForMissingChunk(new Error('A render bug'))).toBe(false);
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    });
    expect(reloadForMissingChunk(MISSING)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
