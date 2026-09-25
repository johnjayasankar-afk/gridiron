/**
 * How big the bowl around the field is, from how many people the venue holds.
 *
 * Every stadium used to be drawn the same: Michigan Stadium, which holds a
 * hundred and seven thousand, and a Division Three ground that holds eight
 * hundred were the same four stands with different end zones. Capacity is the
 * one number that separates them, and it is a real number, looked up per venue
 * and checked in (see fixtures/venues.json and scripts/capture-venues.ts).
 *
 * What this does NOT claim is the shape of any particular stadium. Nobody here
 * has the footprint of Beaver Stadium, and a bowl drawn to look like one it is
 * not would be an invention nobody could check. The field is a schematic and
 * says so; what changes here is its SIZE, from a number that is reported, and
 * how many people are in it.
 *
 * A venue with no capacity gets exactly the bowl Gridiron has always drawn, so
 * an unmatched venue looks like it always did rather than like a guess.
 */

export interface BowlTier {
  /** Centre of the stand's front edge. */
  x: number;
  z: number;
  /** Direction the stand faces, toward the field, as a rotation about y. */
  rotation: number;
  length: number;
  depth: number;
  rows: number;
  rise: number;
}

export interface Bowl {
  tiers: BowlTier[];
  /** Roughly how many seats are lit, which is what makes a big bowl read as full. */
  seats: number;
  /** How far out the floodlight towers stand, so they clear the stands they light. */
  towerX: number;
  towerZ: number;
  /** The capacity this was built from, or null where none is reported. */
  capacity: number | null;
}

/** The bowl Gridiron has always drawn, which is about a seventy thousand seat stadium. */
const REFERENCE = 70_000;

/** Half the field's width, which every stand is placed relative to. */
const HALF_WIDTH = 160 / 6;

/**
 * Sides first, then ends.
 *
 * A stand's seats go up with its rows and along with its length, so a bowl that
 * holds twice as many is not twice as tall: it grows in both directions at once,
 * which is why the scale is a square root. Bounded at both ends because neither
 * a bowl that disappears nor one that swallows the field is useful to look at.
 */
export function bowlFor(capacity: number | null | undefined): Bowl {
  const known = typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0 ? capacity : null;
  const scale = known === null ? 1 : Math.min(1.34, Math.max(0.52, Math.sqrt(known / REFERENCE)));
  const rows = (base: number) => Math.max(3, Math.round(base * scale));
  const side = {
    length: 150 * Math.min(1.16, Math.max(0.72, scale)),
    depth: 26 * scale,
    rows: rows(9),
    rise: 1.7,
  };
  const end = {
    length: 86 * Math.min(1.16, Math.max(0.72, scale)),
    depth: 18 * scale,
    rows: rows(6),
    rise: 1.5,
  };
  /*
   * A small ground is a pair of sideline stands and not a bowl. Under about
   * twenty thousand the ends come off, which is what those grounds actually look
   * like and also stops a tiny stadium reading as a scale model of a huge one.
   */
  const ends = known === null || known >= 20_000;
  const tiers: BowlTier[] = [
    { x: 0, z: -(HALF_WIDTH + 9), rotation: 0, ...side },
    { x: 0, z: HALF_WIDTH + 9, rotation: Math.PI, ...side },
  ];
  if (ends) {
    tiers.push({ x: -79, z: 0, rotation: Math.PI / 2, ...end }, { x: 79, z: 0, rotation: -Math.PI / 2, ...end });
  }
  // Roughly how many lit seats the bowl is worth, so the crowd fills what is actually there.
  const seats = tiers.reduce((n, t) => n + Math.round((t.length / 0.78) * t.rows * 0.54), 0);
  return {
    tiers,
    seats,
    towerX: 84 * Math.max(1, scale),
    towerZ: 54 * Math.max(1, scale),
    capacity: known,
  };
}
