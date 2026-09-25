/**
 * The sky a game is actually being played under.
 *
 * Every field used to be lit the same way, which made a night game in the snow
 * at Lambeau and a one o'clock game in Miami the same picture with different end
 * zones. The provider reports the weather at the venue and whether the venue has
 * a roof, so the field can say so instead.
 *
 * Nothing here is a forecast or a guess. The condition is the provider's own
 * AccuWeather condition id, which carries its own sense of day and night: 33 to
 * 38 are the night forms of 1 to 6, which is the only thing that says a game is
 * being played in the dark, because a venue's local time zone is not reported and
 * a kickoff time in UTC does not say. Where no weather is reported the field is
 * lit plainly, as it was before, rather than being given a sky it was not told
 * about. Indoors there is no weather at all, which is the point of a roof.
 *
 * Condition ids, from the provider's own published scale and from values observed
 * across two full scoreboards on 24 September 2026 (1 to 7 and 35 seen live):
 *   1-5 sun, 6-8 and 35-38 cloud, 11 fog, 12-14 and 18 and 39-40 rain,
 *   15-17 and 41-42 thunderstorms, 19-29 and 43-44 snow and ice,
 *   30 hot, 31 cold, 32 wind, 33-34 clear at night.
 */

/** What the field draws. Ordered from most light to least, which is how the values below read. */
export type SkyKind = 'clear' | 'partly' | 'overcast' | 'fog' | 'rain' | 'storm' | 'snow' | 'roof';

export interface GameWeather {
  /** The provider's AccuWeather condition id, as reported. */
  conditionId: number | null;
  /** Degrees Fahrenheit, as reported. */
  temperature: number | null;
  /** The provider's own words for it, shown rather than rewritten. */
  displayValue: string | null;
}

export interface Sky {
  kind: SkyKind;
  /** True only when the provider's own condition id is one of its night forms. */
  night: boolean;
  indoor: boolean;
  temperature: number | null;
  /** The provider's words, or the roof, for a field to caption itself with. */
  label: string | null;
  /** Something falls out of this sky. */
  precipitation: 'rain' | 'snow' | null;
}

/**
 * The provider's night forms: 33 to 44 are the same conditions as their daytime
 * counterparts, reported after dark. This is the only thing that says a game is
 * being played at night, because a venue's local time zone is not reported and a
 * kickoff time in UTC does not say. It works because the reported condition is
 * the forecast at kickoff, not the weather now: a game kicking off at 8:15 in
 * the evening is reported with a night form hours beforehand.
 */
const NIGHT = new Set([33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44]);

/** Each condition id the provider can send, in the terms a field can be drawn in. */
const KINDS = new Map<number, SkyKind>([
  [1, 'clear'], [2, 'clear'], [33, 'clear'], [34, 'clear'], [30, 'clear'],
  [3, 'partly'], [4, 'partly'], [5, 'partly'], [32, 'partly'], [35, 'partly'], [36, 'partly'], [37, 'partly'],
  [6, 'overcast'], [7, 'overcast'], [8, 'overcast'], [31, 'overcast'], [38, 'overcast'],
  [11, 'fog'],
  [12, 'rain'], [13, 'rain'], [14, 'rain'], [18, 'rain'], [26, 'rain'], [29, 'rain'], [39, 'rain'], [40, 'rain'],
  [15, 'storm'], [16, 'storm'], [17, 'storm'], [41, 'storm'], [42, 'storm'],
  [19, 'snow'], [20, 'snow'], [21, 'snow'], [22, 'snow'], [23, 'snow'], [24, 'snow'], [25, 'snow'], [43, 'snow'], [44, 'snow'],
]);

/** The provider's condition id to what the sky is doing. An id it does not send falls through to null, never to a guess. */
export function skyKindFor(conditionId: number | null): SkyKind | null {
  if (conditionId === null || !Number.isFinite(conditionId)) return null;
  return KINDS.get(conditionId) ?? null;
}

/**
 * The sky for a game, or null when the provider said nothing about it and the
 * venue's roof is unknown too. A field with no sky is lit exactly as it was
 * before there was one.
 */
export function skyFor(weather: GameWeather | null | undefined, indoor: boolean | null | undefined): Sky | null {
  if (indoor === true) return { kind: 'roof', night: false, indoor: true, temperature: weather?.temperature ?? null, label: 'Indoors', precipitation: null };
  const kind = skyKindFor(weather?.conditionId ?? null);
  if (!kind) return null;
  return {
    kind,
    night: NIGHT.has(weather!.conditionId!),
    indoor: false,
    temperature: weather?.temperature ?? null,
    label: weather?.displayValue ?? null,
    precipitation: kind === 'snow' ? 'snow' : kind === 'rain' || kind === 'storm' ? 'rain' : null,
  };
}

/**
 * How a sky lights a field. One number each, so the field, the cards and the 2D
 * fallback all read the same table and cannot drift apart.
 *
 * `light` scales the sun; `ambient` is how much of the sky reaches the shadows,
 * which rises as the sun goes away because an overcast day is a big soft light;
 * `haze` is how much the far end of the field is lost in the air; `tint` is the
 * colour of the light itself, warm in the sun and blue under cloud.
 */
export interface SkyLook {
  light: number;
  ambient: number;
  haze: number;
  tint: string;
}

const LOOKS: Record<SkyKind, SkyLook> = {
  clear: { light: 1.15, ambient: 0.82, haze: 0.06, tint: '#fff4de' },
  partly: { light: 1, ambient: 0.9, haze: 0.12, tint: '#fbf6ec' },
  overcast: { light: 0.66, ambient: 1.08, haze: 0.26, tint: '#e8eef5' },
  fog: { light: 0.5, ambient: 1.18, haze: 0.62, tint: '#e2e8ee' },
  rain: { light: 0.58, ambient: 1.02, haze: 0.38, tint: '#dde6f0' },
  storm: { light: 0.44, ambient: 0.96, haze: 0.46, tint: '#ccd8e8' },
  snow: { light: 0.62, ambient: 1.14, haze: 0.5, tint: '#eef4fb' },
  roof: { light: 1.05, ambient: 1, haze: 0, tint: '#fdfbf4' },
};

/** Night keeps the towers rather than the sun: less light from above, colder, and the air stays clear. */
export function skyLook(sky: Sky | null): SkyLook | null {
  if (!sky) return null;
  const base = LOOKS[sky.kind];
  if (!sky.night) return base;
  return { light: base.light * 0.86, ambient: base.ambient * 0.72, haze: base.haze * 0.7, tint: '#e6edff' };
}

/** How a field captions its own sky: the provider's words, and the temperature where it gave one. */
export function skyLabel(sky: Sky | null): string | null {
  if (!sky) return null;
  const parts = [sky.label, sky.temperature === null ? null : `${Math.round(sky.temperature)}°F`].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The colour a sky multiplies a surface by, as a hex.
 *
 * One piece of arithmetic for both fields. The 3D field multiplies its unlit
 * turf texture by this; the 2D field multiplies its own turf colours by it. They
 * would otherwise be two ideas of what an overcast afternoon looks like, and the
 * fallback is supposed to be the same field drawn another way.
 *
 * `strength` is how much of the weather a surface takes: the holographic field
 * is drawn in light rather than lit, so it takes about a third, enough that a
 * night game reads darker than a one o'clock game and not so much that a neon
 * field turns grey in the rain.
 */
export const SKY_STRENGTH = { holo: 0.35, classic: 1 } as const;

export function skyTint(look: SkyLook | null, strength = 1): string {
  if (!look) return '#ffffff';
  const level = 1 - (1 - Math.min(1.15, look.light)) * strength;
  const hex = look.tint.replace('#', '');
  const channel = (i: number) => {
    const base = parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
    const mixed = base * strength + 1 * (1 - strength);
    return Math.round(Math.max(0, Math.min(1, mixed * level)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** One colour multiplied by another, both hex. How a sky reaches a surface that has its own colour. */
export function multiplyHex(colour: string, by: string): string {
  const parse = (s: string) => {
    const hex = s.replace('#', '');
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 1, 2].map((i) => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255);
  };
  const a = parse(colour);
  const b = parse(by);
  return `#${a
    .map((v, i) =>
      Math.round(Math.max(0, Math.min(1, v * b[i])) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * How much a venue's floodlights are doing, from the sky the game is played
 * under.
 *
 * The bowl was lit the same way at one in the afternoon and at a quarter past
 * eight, which is the one thing about a night game everybody can see. The
 * provider's own condition id says which it is, so the towers, their pools on
 * the grass and their beams carry the scene after dark and sit back in daylight.
 * Indoors they are the only light there is.
 *
 * Exactly 1 with nothing reported, which is the value the bowl has always been
 * drawn at, so a venue the provider said nothing about looks like it always did.
 */
export function towerStrength(sky: Sky | null): number {
  if (!sky) return 1;
  if (sky.indoor) return 1.15;
  if (sky.night) return 1.55;
  // Daylight overwhelms floodlights; a dark afternoon less so.
  return sky.kind === 'clear' ? 0.45 : sky.kind === 'partly' ? 0.6 : 0.82;
}
