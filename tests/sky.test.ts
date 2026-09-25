/**
 * The sky a game is played under, from what the provider reports and nothing else.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FieldSvg } from '../src/field/FieldSvg';
import { game } from './helpers/builders';
import { SKY_STRENGTH, multiplyHex, skyFor, skyKindFor, skyLabel, skyLook, skyTint, towerStrength, type GameWeather } from '../shared/sky';

const weather = (conditionId: number | null, temperature: number | null = 60, displayValue: string | null = 'Reported'): GameWeather => ({ conditionId, temperature, displayValue });

describe('the provider condition id', () => {
  it('reads sun, cloud, rain, storms and snow as themselves', () => {
    expect(skyKindFor(1)).toBe('clear');
    expect(skyKindFor(4)).toBe('partly');
    expect(skyKindFor(7)).toBe('overcast');
    expect(skyKindFor(11)).toBe('fog');
    expect(skyKindFor(18)).toBe('rain');
    expect(skyKindFor(15)).toBe('storm');
    expect(skyKindFor(22)).toBe('snow');
  });

  it("reads each night form as the same weather its daytime counterpart is", () => {
    for (const [day, night] of [
      [1, 33],
      [2, 34],
      [3, 35],
      [4, 36],
      [5, 37],
      [12, 39],
      [15, 41],
      [19, 43],
    ]) {
      expect(skyKindFor(night)).toBe(skyKindFor(day));
    }
  });

  it('has nothing to say about an id it was never given, rather than picking one', () => {
    for (const bad of [0, 9, 10, 45, 999, -1, Number.NaN, null]) expect(skyKindFor(bad)).toBeNull();
  });
});

describe('the sky for a game', () => {
  it('knows a game is at night only from the condition the provider sent', () => {
    // Reported hours before kickoff for a game starting at 8:15 in the evening,
    // which is the case that showed this works: 35 is the night form of 3.
    expect(skyFor(weather(35), false)!.night).toBe(true);
    expect(skyFor(weather(3), false)!.night).toBe(false);
  });

  it('is the roof indoors, with no weather at all', () => {
    const sky = skyFor(weather(22, 20, 'Snow'), true)!;
    expect(sky.kind).toBe('roof');
    expect(sky.indoor).toBe(true);
    expect(sky.precipitation).toBeNull();
    expect(sky.night).toBe(false);
    expect(sky.label).toBe('Indoors');
  });

  it('says what is falling only where the provider said something is', () => {
    expect(skyFor(weather(18), false)!.precipitation).toBe('rain');
    expect(skyFor(weather(15), false)!.precipitation).toBe('rain');
    expect(skyFor(weather(22), false)!.precipitation).toBe('snow');
    expect(skyFor(weather(1), false)!.precipitation).toBeNull();
    expect(skyFor(weather(7), false)!.precipitation).toBeNull();
  });

  it('has no sky at all when nothing was reported, so a field is lit as it always was', () => {
    expect(skyFor(null, null)).toBeNull();
    expect(skyFor(weather(null, null, null), null)).toBeNull();
    expect(skyFor(weather(999), false)).toBeNull();
    expect(skyLook(null)).toBeNull();
    expect(skyLabel(null)).toBeNull();
  });

  it('keeps the temperature even where the condition means nothing to it', () => {
    expect(skyFor(weather(999), true)!.temperature).toBe(60);
  });
});

describe('how a sky lights a field', () => {
  it('gives less sun and more of the sky itself as the weather closes in', () => {
    const clear = skyLook(skyFor(weather(1), false))!;
    const overcast = skyLook(skyFor(weather(7), false))!;
    const storm = skyLook(skyFor(weather(15), false))!;
    expect(clear.light).toBeGreaterThan(overcast.light);
    expect(overcast.light).toBeGreaterThan(storm.light);
    expect(overcast.ambient).toBeGreaterThan(clear.ambient);
    expect(storm.haze).toBeGreaterThan(clear.haze);
    expect(skyLook(skyFor(weather(11), false))!.haze).toBeGreaterThan(storm.haze);
  });

  it('is darker and colder at night, and the air is clearer', () => {
    const day = skyLook(skyFor(weather(3), false))!;
    const night = skyLook(skyFor(weather(35), false))!;
    expect(night.light).toBeLessThan(day.light);
    expect(night.ambient).toBeLessThan(day.ambient);
    expect(night.haze).toBeLessThan(day.haze);
  });

  it('has no haze at all under a roof, because there is no distance to lose', () => {
    expect(skyLook(skyFor(null, true))!.haze).toBe(0);
  });
});

describe('what a field calls its own sky', () => {
  it("uses the provider's own words, with the temperature it gave", () => {
    expect(skyLabel(skyFor(weather(22, 19, 'Snow'), false))).toBe('Snow · 19°F');
    expect(skyLabel(skyFor(weather(1, null, 'Sunny'), false))).toBe('Sunny');
    expect(skyLabel(skyFor(weather(1, 71, null), false))).toBe('71°F');
    expect(skyLabel(skyFor(weather(22, 19, 'Snow'), true))).toBe('Indoors · 19°F');
  });
});

describe('the colour a sky multiplies a surface by', () => {
  const look = (id: number) => skyLook(skyFor(weather(id), false));

  it('leaves a surface alone when there is no reported sky', () => {
    expect(skyTint(null)).toBe('#ffffff');
    expect(multiplyHex('#1d5a3c', '#ffffff')).toBe('#1d5a3c');
  });

  it('darkens as the weather closes in, so a storm is darker than an overcast day is darker than sun', () => {
    const brightness = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(brightness(skyTint(look(1)))).toBeGreaterThan(brightness(skyTint(look(7))));
    expect(brightness(skyTint(look(7)))).toBeGreaterThan(brightness(skyTint(look(15))));
    expect(brightness(skyTint(look(35)))).toBeLessThan(brightness(skyTint(look(3))));
  });

  it('touches the holographic field far less than the painted one, because it is drawn in light rather than lit', () => {
    const brightness = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(brightness(skyTint(look(15), SKY_STRENGTH.holo))).toBeGreaterThan(brightness(skyTint(look(15), SKY_STRENGTH.classic)));
  });

  it('multiplies one colour by another, channel by channel, and never leaves the range', () => {
    expect(multiplyHex('#808080', '#808080')).toBe('#404040');
    expect(multiplyHex('#fff', '#000000')).toBe('#000000');
    expect(multiplyHex('#1d5a3c', '#ffffff')).toBe('#1d5a3c');
  });
});

/**
 * The 2D field is what Reduced effects, 2D effects mode and a device with no
 * WebGL get. It is meant to be the same field drawn another way, so it is lit by
 * the same sky through the same arithmetic.
 */
describe('the 2D field under its own sky', () => {
  const render = (weather: GameWeather | null, venue: Partial<NonNullable<ReturnType<typeof game>['venue']>> = {}) => {
    const g = game({ id: 'nfl-1' });
    const withSky = { ...g, weather, venue: { id: '1', name: 'Test Field', city: null, state: null, indoor: null, grass: null, ...venue } };
    return renderToStaticMarkup(createElement(FieldSvg, { game: withSky, situation: withSky.situation }));
  };

  it('is drawn darker in a storm than in the sun, and darker still after dark', () => {
    const green = (html: string) => {
      const m = /<rect width="[\d.]+" height="[\d.]+" fill="(#[0-9a-f]{6})"/.exec(html);
      if (!m) throw new Error('the 2D turf no longer starts with the stripe pattern this reads');
      return parseInt(m[1].slice(3, 5), 16);
    };
    const sun = green(render(weather(1)));
    const storm = green(render(weather(15)));
    const night = green(render(weather(33)));
    expect(storm).toBeLessThan(sun);
    expect(night).toBeLessThan(sun);
  });

  it('is exactly as it always was when nothing was reported', () => {
    expect(render(null)).toContain('#1d5a3c');
    expect(render(null)).toContain('#21633f');
  });

  it('drops its mowing stripes on a surface that cannot be mown', () => {
    // Two different greens on grass, one colour repeated on a synthetic surface.
    expect(render(null, { grass: true })).toContain('#21633f');
    expect(render(null, { grass: false })).not.toContain('#21633f');
  });

  it('tells a screen reader what the field is lit by, in the provider\'s own words', () => {
    expect(render(weather(22, 19, 'Snow'))).toContain('Reported at the venue: Snow · 19°F.');
    expect(render(null)).not.toContain('Reported at the venue');
  });
});

describe("what the venue's floodlights are doing", () => {
  it('is exactly what it has always been when nothing was reported, so an unreported venue is unchanged', () => {
    expect(towerStrength(null)).toBe(1);
  });

  it('carries the scene after dark and sits back in daylight', () => {
    const night = towerStrength(skyFor(weather(33), false));
    const sun = towerStrength(skyFor(weather(1), false));
    const overcast = towerStrength(skyFor(weather(7), false));
    expect(night).toBeGreaterThan(1);
    expect(sun).toBeLessThan(1);
    // A dark afternoon leaves more for the towers to do than a bright one.
    expect(overcast).toBeGreaterThan(sun);
    expect(overcast).toBeLessThan(night);
  });

  it('is the only light there is indoors', () => {
    expect(towerStrength(skyFor(weather(1), true))).toBeGreaterThan(1);
  });
});
