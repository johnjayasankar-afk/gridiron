/**
 * QR codes: a dependency-free encoder for QR Code Model 2, so a link can be shown as a scannable square.
 *
 * The whole text goes into one segment in the most compact mode it allows: numeric, alphanumeric, or byte
 * mode holding UTF-8 (with no ECI header; common scanners read UTF-8 byte data without one). The smallest
 * version that holds the segment at the requested error correction level is used. The data codewords are
 * split into the standard blocks, each block gets Reed-Solomon codewords over GF(256), and the blocks are
 * interleaved and laid in the zigzag around the function patterns. All eight masks are tried and the one
 * with the lowest penalty under the four standard rules is kept.
 *
 * It runs the same in the browser and in Node: the only platform API it touches is TextEncoder.
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
  /** Error correction level: L restores about 7% of codewords, M 15%, Q 25%, H 30%. Default 'M'. */
  ecc?: QrEcc;
  /** Smallest version to use, 1 to 40. Default 1. */
  minVersion?: number;
  /** Largest version to use, 1 to 40. Default 40. */
  maxVersion?: number;
}

export interface QrCode {
  version: number;
  /** Modules per side, 17 + 4 * version, not counting a quiet zone. */
  size: number;
  ecc: QrEcc;
  /** The mask pattern applied, 0 to 7. */
  mask: number;
  /** Rows of modules, read as modules[y][x]; true is dark. */
  modules: boolean[][];
}

type Mode = 'numeric' | 'alphanumeric' | 'byte';

interface Segment {
  mode: Mode;
  /** Characters in numeric and alphanumeric mode, bytes in byte mode. */
  count: number;
  /** Bits after the mode indicator and character count. */
  payloadBits: number;
  write: (bits: number[]) => void;
}

/** A module grid under construction, stored row by row. */
interface Grid {
  size: number;
  dark: Uint8Array;
  /** 1 under function patterns and format and version information, which data never covers. */
  reserved: Uint8Array;
}

export interface QrPenalties {
  /** Rule 1: runs of five or more same colored modules in a row or column. */
  runs: number;
  /** Rule 2: same colored 2 by 2 blocks. */
  blocks: number;
  /** Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on a side. */
  finders: number;
  /** Rule 4: how far the share of dark modules strays from half. */
  balance: number;
}

const ECC_LEVELS: readonly QrEcc[] = ['L', 'M', 'Q', 'H'];
/** The two error correction level bits of the format information. */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** Error correction codewords in each block, indexed by version (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Number of error correction blocks, indexed by version (index 0 unused). */
const ECC_BLOCKS: Record<QrEcc, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const MODE_INDICATOR: Record<Mode, number> = { numeric: 0b0001, alphanumeric: 0b0010, byte: 0b0100 };
/** Character count indicator lengths for versions 1 to 9, 10 to 26 and 27 to 40. */
const COUNT_BITS: Record<Mode, readonly number[]> = { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] };
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const UTF8 = new TextEncoder();

const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

/** Mask conditions by pattern number, for column x and row y: a module is inverted where its condition holds. */
const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** GF(256) under the QR polynomial x^8 + x^4 + x^3 + x^2 + 1: the powers of 2, doubled up to skip a modulo, and their logarithms. */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  GF_EXP[i] = x;
  GF_LOG[x] = i;
  x = x & 0x80 ? (x << 1) ^ 0x11d : x << 1;
}
for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];

/**
 * Encodes text as a QR code at the smallest version from minVersion to maxVersion that holds it.
 * Throws a RangeError for invalid options and an Error when the text does not fit.
 */
export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const ecc = options.ecc ?? 'M';
  const minVersion = options.minVersion ?? 1;
  const maxVersion = options.maxVersion ?? 40;
  if (!ECC_LEVELS.includes(ecc)) throw new RangeError(`QR error correction level must be L, M, Q or H, not ${String(ecc)}`);
  if (!Number.isInteger(minVersion) || !Number.isInteger(maxVersion) || minVersion < 1 || maxVersion > 40 || minVersion > maxVersion) {
    throw new RangeError(`QR versions must be whole numbers with 1 <= minVersion <= maxVersion <= 40, not ${minVersion} and ${maxVersion}`);
  }
  const segments = segmentsFor(text);
  for (let version = minVersion; version <= maxVersion; version++) {
    const segment = compactSegment(segments, version);
    if (segmentBits(segment, version) <= dataCapacity(version, ecc) * 8) return buildSymbol(version, ecc, dataCodewords(segment, version, ecc), null);
  }
  const needed = segmentBits(compactSegment(segments, maxVersion), maxVersion);
  throw new Error(
    `Text is too long for a QR code at ECC ${ecc} up to version ${maxVersion}: it needs ${Number.isFinite(needed) ? needed : 'more'} data bits and version ${maxVersion} holds ${dataCapacity(maxVersion, ecc) * 8}`,
  );
}

/**
 * One SVG path covering the dark modules, a rectangle per horizontal run, with a quiet zone of margin modules
 * on every side. Render it as <svg viewBox={viewBox}><path d={path} fill="#000" /></svg> on a light background.
 */
export function qrSvgPath(qr: QrCode, margin = 4): { path: string; viewBox: string } {
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let end = x + 1;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x + margin} ${y + margin}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  const extent = qr.size + margin * 2;
  return { path: parts.join(''), viewBox: `0 0 ${extent} ${extent}` };
}

function gfMultiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

const generators = new Map<number, Uint8Array>();

/** The generator polynomial (x - 1)(x - 2)(x - 2^2)...(x - 2^(degree - 1)), highest power first, without its leading 1. */
function rsGenerator(degree: number): Uint8Array {
  let generator = generators.get(degree);
  if (!generator) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array<number>(poly.length + 1).fill(0);
      poly.forEach((coefficient, j) => {
        next[j] ^= coefficient;
        next[j + 1] ^= gfMultiply(coefficient, GF_EXP[i]);
      });
      poly = next;
    }
    generator = Uint8Array.from(poly.slice(1));
    generators.set(degree, generator);
  }
  return generator;
}

/** Reed-Solomon error correction codewords for one block: the remainder of data * x^degree divided by the generator. */
function reedSolomon(data: ArrayLike<number>, degree: number): number[] {
  const generator = rsGenerator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ (remainder.shift() as number);
    remainder.push(0);
    if (factor !== 0) for (let j = 0; j < degree; j++) remainder[j] ^= gfMultiply(generator[j], factor);
  }
  return remainder;
}

/** Modules left for codewords (and remainder bits) once function patterns and format and version information are placed. */
function rawDataModules(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    modules -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) modules -= 36;
  }
  return modules;
}

/** Data codewords a version holds at a level. */
function dataCapacity(version: number, ecc: QrEcc): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][version] * ECC_BLOCKS[ecc][version];
}

function countBits(mode: Mode, version: number): number {
  return COUNT_BITS[mode][version < 10 ? 0 : version < 27 ? 1 : 2];
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** The single segment modes that can carry the whole text, most compact first. Byte mode always can. */
function segmentsFor(text: string): Segment[] {
  const segments: Segment[] = [];
  if (/^[0-9]*$/.test(text)) {
    segments.push({
      mode: 'numeric',
      count: text.length,
      payloadBits: Math.floor(text.length / 3) * 10 + [0, 4, 7][text.length % 3],
      write: (bits) => {
        for (let i = 0; i < text.length; i += 3) {
          const group = text.slice(i, i + 3);
          appendBits(bits, Number(group), group.length * 3 + 1);
        }
      },
    });
  }
  if (/^[0-9A-Z $%*+\-.\/:]*$/.test(text)) {
    segments.push({
      mode: 'alphanumeric',
      count: text.length,
      payloadBits: Math.floor(text.length / 2) * 11 + (text.length % 2) * 6,
      write: (bits) => {
        for (let i = 0; i < text.length; i += 2) {
          const first = ALPHANUMERIC.indexOf(text[i]);
          if (i + 1 < text.length) appendBits(bits, first * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
          else appendBits(bits, first, 6);
        }
      },
    });
  }
  const bytes = UTF8.encode(text);
  segments.push({ mode: 'byte', count: bytes.length, payloadBits: bytes.length * 8, write: (bits) => bytes.forEach((byte) => appendBits(bits, byte, 8)) });
  return segments;
}

/** Bits a segment takes at a version, or Infinity when its length overflows the character count indicator. */
function segmentBits(segment: Segment, version: number): number {
  const lengthBits = countBits(segment.mode, version);
  return segment.count < 2 ** lengthBits ? 4 + lengthBits + segment.payloadBits : Infinity;
}

function compactSegment(segments: Segment[], version: number): Segment {
  return segments.reduce((best, segment) => (segmentBits(segment, version) < segmentBits(best, version) ? segment : best));
}

/** The data codewords: mode, count and payload, then the terminator, zero bits to a byte boundary, and alternating pad bytes. */
function dataCodewords(segment: Segment, version: number, ecc: QrEcc): number[] {
  const capacity = dataCapacity(version, ecc) * 8;
  const bits: number[] = [];
  appendBits(bits, MODE_INDICATOR[segment.mode], 4);
  appendBits(bits, segment.count, countBits(segment.mode, version));
  segment.write(bits);
  if (bits.length > capacity) throw new Error(`QR data needs ${bits.length} bits but version ${version} at ECC ${ecc} holds ${capacity}`);
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0xec; codewords.length < capacity / 8; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/**
 * Splits the data codewords into blocks (the shorter blocks first, longer ones holding one more codeword), computes each
 * block's error correction codewords, and interleaves: data codewords column by column across blocks, then the same for
 * error correction.
 */
function withErrorCorrection(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const blockCount = ECC_BLOCKS[ecc][version];
  const eccLength = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const total = Math.floor(rawDataModules(version) / 8);
  const shortLength = Math.floor(total / blockCount) - eccLength;
  const shortBlocks = blockCount - (total % blockCount);
  const blocks: number[][] = [];
  const checks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < blockCount; b++) {
    const length = shortLength + (b < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    blocks.push(block);
    checks.push(reedSolomon(block, eccLength));
  }
  const result: number[] = [];
  for (let i = 0; i <= shortLength; i++) for (const block of blocks) if (i < block.length) result.push(block[i]);
  for (let i = 0; i < eccLength; i++) for (const check of checks) result.push(check[i]);
  return result;
}

/** Centers of the alignment patterns along each axis. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const positions = [6];
  for (let position = version * 4 + 10; positions.length < count; position -= step) positions.splice(1, 0, position);
  return positions;
}

function setFunctionModule(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.dark[y * grid.size + x] = dark ? 1 : 0;
  grid.reserved[y * grid.size + x] = 1;
}

/** The 15 bit format information: level and mask, then BCH (15,5) check bits, XOR 101010000010010. */
function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The 18 bit version information: the version, then BCH (18,6) check bits. */
function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

/** Both copies of the format information, bit 0 first, and the dark module. */
function drawFormat(grid: Grid, ecc: QrEcc, mask: number): void {
  const bits = formatBits(ecc, mask);
  const size = grid.size;
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    // Beside the top left finder: down column 8, then left along row 8, stepping over the timing patterns.
    if (i < 6) setFunctionModule(grid, 8, i, dark);
    else if (i < 8) setFunctionModule(grid, 8, i + 1, dark);
    else if (i === 8) setFunctionModule(grid, 7, 8, dark);
    else setFunctionModule(grid, 14 - i, 8, dark);
    // Split between the other finders: right to left under the top right one, then down beside the bottom left one.
    if (i < 8) setFunctionModule(grid, size - 1 - i, 8, dark);
    else setFunctionModule(grid, 8, size - 15 + i, dark);
  }
  setFunctionModule(grid, 8, size - 8, true);
}

/** Version information, bit 0 first: a block 3 wide and 6 tall left of the top right finder, mirrored above the bottom left one. */
function drawVersion(grid: Grid, version: number): void {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const across = grid.size - 11 + (i % 3);
    const along = Math.floor(i / 3);
    setFunctionModule(grid, across, along, dark);
    setFunctionModule(grid, along, across, dark);
  }
}

/** A grid with the function patterns and version information drawn and the format information area reserved. */
function functionPatterns(version: number): Grid {
  const size = version * 4 + 17;
  const grid: Grid = { size, dark: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
  for (let i = 0; i < size; i++) {
    setFunctionModule(grid, 6, i, i % 2 === 0);
    setFunctionModule(grid, i, 6, i % 2 === 0);
  }
  // Finder patterns with their light separators, clipped at the edge: rings 0, 1 and 3 around the center are dark.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && y >= 0 && x < size && y < size) setFunctionModule(grid, x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((cy, row) => {
    positions.forEach((cx, column) => {
      // No alignment pattern in the three corners the finders take.
      if ((row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFunctionModule(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  drawFormat(grid, 'L', 0);
  if (version >= 7) drawVersion(grid, version);
  return grid;
}

/** Lays codeword bits, most significant first, in the zigzag: two columns at a time from the right, alternately up and down, skipping column 6. */
function placeCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size, dark, reserved } = grid;
  const totalBits = codewords.length * 8;
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= right === 8 ? 3 : 2) {
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let x = right; x >= right - 1; x--) {
        const index = y * size + x;
        if (reserved[index] || bit >= totalBits) continue;
        dark[index] = (codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
  }
}

function applyMask(grid: Grid, mask: number): Uint8Array {
  const { size, reserved } = grid;
  const masked = grid.dark.slice();
  const invert = MASKS[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      if (!reserved[index] && invert(x, y)) masked[index] ^= 1;
    }
  }
  return masked;
}

/** Scores a finished symbol under the four penalty rules. Rule 3 treats the quiet zone past the edge as light. */
function penalties(dark: Uint8Array, size: number): QrPenalties {
  let runs = 0;
  let finders = 0;
  const line = new Uint8Array(size);
  const lightSpan = (from: number, to: number): boolean => {
    for (let i = Math.max(0, from); i < Math.min(size, to); i++) if (line[i]) return false;
    return true;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) line[b] = pass === 0 ? dark[a * size + b] : dark[b * size + a];
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && line[b] === line[b - 1]) run++;
        else {
          if (run >= 5) runs += PENALTY_RUN + run - 5;
          run = 1;
        }
      }
      for (let b = 0; b + 7 <= size; b++) {
        if (line[b] && !line[b + 1] && line[b + 2] && line[b + 3] && line[b + 4] && !line[b + 5] && line[b + 6]) {
          if (lightSpan(b - 4, b)) finders += PENALTY_FINDER;
          if (lightSpan(b + 7, b + 11)) finders += PENALTY_FINDER;
        }
      }
    }
  }
  let blocks = 0;
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      darkCount += dark[index];
      const color = dark[index];
      if (x + 1 < size && y + 1 < size && dark[index + 1] === color && dark[index + size] === color && dark[index + size + 1] === color) blocks += PENALTY_BLOCK;
    }
  }
  const total = size * size;
  const balance = Math.max(0, Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * PENALTY_BALANCE;
  return { runs, blocks, finders, balance };
}

/** Adds error correction to the data codewords, places them, and applies the mask with the lowest penalty or the one forced. */
function buildSymbol(version: number, ecc: QrEcc, data: readonly number[], forcedMask: number | null): QrCode {
  const base = functionPatterns(version);
  placeCodewords(base, withErrorCorrection(data, version, ecc));
  const size = base.size;
  const masks = forcedMask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
  const candidates = masks.map((mask) => {
    const grid: Grid = { size, dark: applyMask(base, mask), reserved: base.reserved };
    drawFormat(grid, ecc, mask);
    const score = penalties(grid.dark, size);
    return { mask, dark: grid.dark, total: score.runs + score.blocks + score.finders + score.balance };
  });
  const best = candidates.reduce((chosen, candidate) => (candidate.total < chosen.total ? candidate : chosen));
  const modules = Array.from({ length: size }, (_row, y) => Array.from({ length: size }, (_column, x) => best.dark[y * size + x] === 1));
  return { version, size, ecc, mask: best.mask, modules };
}

/** Internal steps, exported for unit tests and verification scripts only. Not part of the API. */
export const __testing = {
  /** Data codewords for text at a version and level in the most compact mode, before error correction. */
  dataCodewords: (text: string, version: number, ecc: QrEcc): number[] => dataCodewords(compactSegment(segmentsFor(text), version), version, ecc),
  reedSolomon,
  withErrorCorrection,
  formatBits,
  versionBits,
  alignmentPositions,
  rawDataModules,
  dataCapacity,
  /** Modules of a version taken by function patterns and format and version information, as reserved[y][x]. */
  reservedModules: (version: number): boolean[][] => {
    const { size, reserved } = functionPatterns(version);
    return Array.from({ length: size }, (_row, y) => Array.from({ length: size }, (_column, x) => reserved[y * size + x] === 1));
  },
  penalties: (modules: boolean[][]): QrPenalties => penalties(Uint8Array.from(modules.flat(), (dark) => (dark ? 1 : 0)), modules.length),
  /** The symbol for text at exactly one version with the given mask instead of the best one. */
  encodeWithMask: (text: string, version: number, ecc: QrEcc, mask: number): QrCode =>
    buildSymbol(version, ecc, dataCodewords(compactSegment(segmentsFor(text), version), version, ecc), mask),
};
