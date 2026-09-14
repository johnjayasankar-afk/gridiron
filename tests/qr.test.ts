import { describe, expect, it } from 'vitest';
import { __testing, encodeQr, qrSvgPath, type QrCode, type QrEcc } from '../shared/qr';

const { alignmentPositions, dataCapacity, dataCodewords, encodeWithMask, formatBits, penalties, rawDataModules, reedSolomon, reservedModules, versionBits, withErrorCorrection } = __testing;

type Cell = [x: number, y: number];

/** GF(256) multiplication by shift and add, independent of the encoder's log tables. */
const gfMul = (a: number, b: number): number => {
  let product = 0;
  for (let x = a, y = b; y > 0; y >>= 1) {
    if (y & 1) product ^= x;
    x = x & 0x80 ? (x << 1) ^ 0x11d : x << 1;
  }
  return product;
};

const bits = (value: number, length: number) => value.toString(2).padStart(length, '0');
const distance = (a: number, b: number) => [...bits(a ^ b, 32)].filter((bit) => bit === '1').length;
const read = (qr: QrCode, cells: Cell[]) => cells.reduce((value, [x, y]) => (value << 1) | (qr.modules[y][x] ? 1 : 0), 0);

/** Where scanners read the two format information copies, most significant bit first. */
const formatCells = (size: number): Cell[][] => [
  [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]],
  [...Array.from({ length: 7 }, (_, i): Cell => [8, size - 1 - i]), ...Array.from({ length: 8 }, (_, i): Cell => [size - 8 + i, 8])],
];

/** Where scanners read the two version information blocks, most significant bit first. */
const versionCells = (size: number): Cell[][] => {
  const topRight: Cell[] = [];
  const bottomLeft: Cell[] = [];
  for (let a = 5; a >= 0; a--) {
    for (let b = size - 9; b >= size - 11; b--) {
      topRight.push([b, a]);
      bottomLeft.push([a, b]);
    }
  }
  return [topRight, bottomLeft];
};

/** The standard mask conditions for row i and column j. */
const MASK_CONDITIONS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

/** Compares a square of modules with a pattern given by its distance from the center in rings. */
const expectRings = (qr: QrCode, cx: number, cy: number, radius: number, dark: (ring: number) => boolean) => {
  const actual: boolean[] = [];
  const expected: boolean[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) continue;
      actual.push(qr.modules[y][x]);
      expected.push(dark(Math.max(Math.abs(dx), Math.abs(dy))));
    }
  }
  expect(actual).toEqual(expected);
};

describe('QR error correction', () => {
  it('matches the tutorial HELLO WORLD example at version 1-M', () => {
    const data = dataCodewords('HELLO WORLD', 1, 'M');
    expect(data).toEqual([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    expect(withErrorCorrection(data, 1, 'M')).toEqual([...data, 196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('produces codewords with zero syndromes for every error correction length the tables use', () => {
    let seed = 7;
    for (const degree of [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30]) {
      const data = Array.from({ length: 40 }, () => (seed = (seed * 73 + 41) % 251));
      const codeword = [...data, ...reedSolomon(data, degree)];
      const syndromes: number[] = [];
      for (let i = 0, root = 1; i < degree; i++, root = gfMul(root, 2)) syndromes.push(codeword.reduce((acc, c) => gfMul(acc, root) ^ c, 0));
      expect(syndromes).toEqual(new Array(degree).fill(0));
    }
  });

  it('splits version 5-Q into two short and two long blocks and interleaves them', () => {
    const data = Array.from({ length: 62 }, (_, i) => i);
    const out = withErrorCorrection(data, 5, 'Q');
    expect(out).toHaveLength(134);
    expect(out.slice(0, 8)).toEqual([0, 15, 30, 46, 1, 16, 31, 47]);
    expect(out.slice(56, 62)).toEqual([14, 29, 44, 60, 45, 61]);
    const checks = [data.slice(0, 15), data.slice(15, 30), data.slice(30, 46), data.slice(46)].map((block) => reedSolomon(block, 18));
    expect(out.slice(62)).toEqual(Array.from({ length: 72 }, (_, i) => checks[i % 4][Math.floor(i / 4)]));
  });
});

describe('QR format and version information', () => {
  it('matches the standard format information table', () => {
    expect(bits(formatBits('M', 0), 15)).toBe('101010000010010');
    expect(bits(formatBits('L', 4), 15)).toBe('110011000101111');
    expect(bits(formatBits('Q', 0), 15)).toBe('011010101011111');
    expect(bits(formatBits('H', 0), 15)).toBe('001011010001001');
    const all = (['L', 'M', 'Q', 'H'] as QrEcc[]).flatMap((ecc) => Array.from({ length: 8 }, (_, mask) => formatBits(ecc, mask)));
    const nearest = Math.min(...all.flatMap((a, i) => all.slice(i + 1).map((b) => distance(a, b))));
    expect(nearest).toBe(7);
  });

  it('matches the standard version information table', () => {
    expect(bits(versionBits(7), 18)).toBe('000111110010010100');
    expect(bits(versionBits(8), 18)).toBe('001000010110111100');
    expect(bits(versionBits(40), 18)).toBe('101000110001101001');
    const all = Array.from({ length: 34 }, (_, i) => versionBits(i + 7));
    expect(Math.min(...all.flatMap((a, i) => all.slice(i + 1).map((b) => distance(a, b))))).toBeGreaterThanOrEqual(8);
  });

  it('writes both format copies and both version blocks where scanners read them', () => {
    for (const [text, ecc, version] of [['HELLO WORLD', 'Q', 1], ['https://gridiron.example/', 'H', 7], ['gridiron', 'L', 23]] as const) {
      const qr = encodeQr(text, { ecc, minVersion: version });
      expect(qr.version).toBe(version);
      for (const cells of formatCells(qr.size)) expect(bits(read(qr, cells), 15)).toBe(bits(formatBits(ecc, qr.mask), 15));
      if (version >= 7) for (const cells of versionCells(qr.size)) expect(bits(read(qr, cells), 18)).toBe(bits(versionBits(version), 18));
    }
  });
});

describe('QR symbol structure', () => {
  it('sizes version 1 at 21 modules and version 40 at 177', () => {
    expect(encodeQr('HELLO WORLD').size).toBe(21);
    const v40 = encodeQr('HELLO WORLD', { minVersion: 40 });
    expect(v40).toMatchObject({ version: 40, size: 177 });
    expect(v40.modules).toHaveLength(177);
    expect(v40.modules.every((row) => row.length === 177)).toBe(true);
  });

  it('draws finder patterns with light separators in three corners', () => {
    for (const qr of [encodeQr('HELLO WORLD'), encodeQr('HELLO WORLD', { minVersion: 10 })]) {
      for (const [cx, cy] of [[3, 3], [qr.size - 4, 3], [3, qr.size - 4]]) expectRings(qr, cx, cy, 4, (ring) => ring !== 2 && ring !== 4);
    }
  });

  it('draws timing patterns between the finders and the dark module', () => {
    for (const version of [1, 7, 40]) {
      const qr = encodeQr('1', { minVersion: version });
      const row = qr.modules[6].slice(8, qr.size - 8);
      const column = qr.modules.slice(8, qr.size - 8).map((line) => line[6]);
      expect(row).toEqual(row.map((_, i) => i % 2 === 0));
      expect(column).toEqual(row.map((_, i) => i % 2 === 0));
      expect(qr.modules[4 * version + 9][8]).toBe(true);
    }
  });

  it('places alignment patterns at the standard centers', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
    const qr = encodeQr('1', { minVersion: 7 });
    for (const [cx, cy] of [[22, 22], [38, 22], [22, 38], [38, 38], [6, 22], [22, 6]]) expectRings(qr, cx, cy, 2, (ring) => ring !== 1);
  });

  it('leaves the standard number of codewords for data and error correction', () => {
    for (let version = 1; version <= 40; version++) expect(reservedModules(version).flat().filter((taken) => !taken)).toHaveLength(rawDataModules(version));
    expect([1, 7, 14, 40].map((version) => Math.floor(rawDataModules(version) / 8))).toEqual([26, 196, 581, 3706]);
    expect([1, 5, 10, 40].map((version) => dataCapacity(version, 'M'))).toEqual([16, 86, 216, 2334]);
  });
});

describe('QR encoding', () => {
  it('uses the most compact single mode for the whole text', () => {
    expect(dataCodewords('01234567', 1, 'M')).toEqual([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
    expect(dataCodewords('HELLO WORLD', 1, 'M')[0] >> 4).toBe(0b0010);
    expect(dataCodewords('Hello World', 1, 'M')[0] >> 4).toBe(0b0100);
    expect(dataCodewords('héllo', 1, 'M')).toEqual([0x40, 0x66, 0x8c, 0x3a, 0x96, 0xc6, 0xc6, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
  });

  it('picks the smallest version that holds the text in byte mode at ECC M', () => {
    const version = (length: number) => encodeQr('a'.repeat(length)).version;
    expect([14, 15, 26, 27, 213, 214].map(version)).toEqual([1, 2, 2, 3, 10, 11]);
    expect(encodeQr('a'.repeat(15), { minVersion: 5 }).version).toBe(5);
  });

  it('fills version 40 to capacity at each level and rejects one byte more', () => {
    for (const [ecc, capacity] of [['L', 2953], ['M', 2331], ['Q', 1663], ['H', 1273]] as const) {
      expect(encodeQr('a'.repeat(capacity), { ecc })).toMatchObject({ version: 40, ecc });
      expect(() => encodeQr('a'.repeat(capacity + 1), { ecc })).toThrow(/too long/);
    }
  });

  it('throws a clear error for overlong input and invalid options', () => {
    expect(() => encodeQr('a'.repeat(15), { maxVersion: 1 })).toThrow('Text is too long for a QR code at ECC M up to version 1: it needs 132 data bits and version 1 holds 128');
    expect(() => encodeQr('x', { minVersion: 0 })).toThrow(RangeError);
    expect(() => encodeQr('x', { minVersion: 3, maxVersion: 2 })).toThrow(RangeError);
    expect(() => encodeQr('x', { maxVersion: 41 })).toThrow(RangeError);
    expect(() => encodeQr('x', { ecc: 'X' as QrEcc })).toThrow(RangeError);
  });

  it('keeps the mask with the lowest penalty, and every mask unmasks to the same data', () => {
    const text = 'https://gridiron.example/?party=3f2c9a1e';
    const qr = encodeQr(text);
    const symbols = Array.from({ length: 8 }, (_, mask) => encodeWithMask(text, qr.version, 'M', mask));
    const totals = symbols.map((symbol) => Object.values(penalties(symbol.modules)).reduce((sum, value) => sum + value, 0));
    expect(totals.indexOf(Math.min(...totals))).toBe(qr.mask);
    expect(symbols[qr.mask].modules).toEqual(qr.modules);
    const reserved = reservedModules(qr.version);
    const unmasked = symbols.map((symbol, mask) => symbol.modules.map((row, i) => row.map((dark, j) => !reserved[i][j] && dark !== MASK_CONDITIONS[mask](i, j))));
    for (let mask = 1; mask < 8; mask++) expect(unmasked[mask]).toEqual(unmasked[0]);
  });

  it('scores each of the four penalty rules', () => {
    // All light but one row holding a finder-like 1011101 with light on both sides.
    const grid = Array.from({ length: 15 }, (_, y) => Array.from({ length: 15 }, (_, x) => y === 7 && [4, 6, 7, 8, 10].includes(x)));
    expect(penalties(grid)).toEqual({ runs: 362, blocks: 540, finders: 80, balance: 90 });
  });
});

describe('QR SVG path', () => {
  it('paints each dark module once, one segment per run, inside the quiet zone', () => {
    const qr = encodeQr('https://gridiron.example/');
    const runs = qr.modules.reduce((count, row) => count + row.filter((dark, x) => dark && !row[x - 1]).length, 0);
    for (const margin of [4, 0]) {
      const { path, viewBox } = qrSvgPath(qr, margin);
      const extent = qr.size + margin * 2;
      expect(viewBox).toBe(`0 0 ${extent} ${extent}`);
      const painted = Array.from({ length: extent }, () => new Array<number>(extent).fill(0));
      let consumed = 0;
      let segments = 0;
      for (const [whole, x, y, width, back] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
        expect(back).toBe(width);
        for (let i = 0; i < Number(width); i++) painted[Number(y)][Number(x) + i]++;
        consumed += whole.length;
        segments++;
      }
      expect(consumed).toBe(path.length);
      expect(segments).toBe(runs);
      expect(painted).toEqual(painted.map((row, y) => row.map((_, x) => (qr.modules[y - margin]?.[x - margin] ? 1 : 0))));
    }
  });
});
