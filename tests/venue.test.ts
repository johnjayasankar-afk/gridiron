/**
 * The arena a game is actually being played in.
 *
 * Every field Gridiron draws is a schematic on purpose: the real orientation of
 * a stadium is not reported and neither is its shape, so the field says what it
 * knows. That leaves one honest way to show the actual place, which is the
 * actual picture of it, and the provider publishes one for most venues.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeVenueImage } from '../server/providers/espn/odds';
import type { GameSummary } from '../shared/model';
import { VenuePhoto } from '../src/views/detail/VenuePhoto';

// Shapes copied from venue documents fetched on 24 September 2026.
const interior = { href: 'https://a.espncdn.com/i/venues/nfl/day/interior/3798.jpg', width: 2000, height: 1125, alt: '', rel: ['full', 'day', 'interior'] };
const exterior = { href: 'https://a.espncdn.com/i/venues/nfl/day/3798.jpg', width: 2000, height: 1125, alt: '', rel: ['full', 'day'] };

describe("the provider's photograph of a venue", () => {
  it('prefers the inside of the bowl, which is what somebody watching a game wants to see', () => {
    expect(normalizeVenueImage([exterior, interior])).toEqual({ href: interior.href, width: 2000, height: 1125, interior: true });
    expect(normalizeVenueImage([interior, exterior])!.interior).toBe(true);
  });

  it('takes the outside when that is all there is', () => {
    expect(normalizeVenueImage([exterior])).toEqual({ href: exterior.href, width: 2000, height: 1125, interior: false });
  });

  it('has nothing for a venue the provider published none for, rather than a guessed address', () => {
    // Brooks Stadium really does ship an empty array, and a guessed path there answers with a different venue's picture.
    expect(normalizeVenueImage([])).toBeNull();
    expect(normalizeVenueImage(null)).toBeNull();
    expect(normalizeVenueImage(undefined)).toBeNull();
  });

  it('refuses anything that is not a plain https address', () => {
    expect(normalizeVenueImage([{ ...interior, href: 'http://a.espncdn.com/x.jpg' }])).toBeNull();
    expect(normalizeVenueImage([{ ...interior, href: 'javascript:alert(1)' }])).toBeNull();
    expect(normalizeVenueImage([{ ...interior, href: 42 }])).toBeNull();
  });

  it('refuses one it cannot hold the space for, because a late picture that shifts the page is worse than none', () => {
    expect(normalizeVenueImage([{ ...interior, width: undefined }])).toBeNull();
    expect(normalizeVenueImage([{ ...interior, height: 0 }])).toBeNull();
  });
});

const venue = (extra: Partial<NonNullable<GameSummary['venue']>> = {}): NonNullable<GameSummary['venue']> => ({
  id: '3798',
  name: 'Lambeau Field',
  city: 'Green Bay',
  state: 'WI',
  indoor: false,
  grass: true,
  image: null,
  capacity: null,
  ...extra,
});

const render = (v: NonNullable<GameSummary['venue']>) => renderToStaticMarkup(createElement(VenuePhoto, { venue: v }));

/**
 * The summary payload a game page already fetches carries the venue's id, its
 * surface and its photographs, so the picture needs no second request. That was
 * not obvious: the venue's own document was being fetched for it, which is a
 * round trip for something already in hand.
 */
describe('the photograph in the payload a game page already has', () => {
  it('is read straight out of the game summary, rather than asked for again', () => {
    const summary = {
      header: { id: '401858463', league: { name: 'NCAA', abbreviation: 'NCAAF' }, competitions: [{ id: '401858463', competitors: [] }] },
      gameInfo: { venue: { id: '3558', fullName: 'Michigan Stadium', grass: false, images: [interior] } },
    };
    // The shape is what the provider actually returns; only the reading is asserted here.
    expect(normalizeVenueImage(summary.gameInfo.venue.images)).toEqual({ href: interior.href, width: 2000, height: 1125, interior: true });
  });
});

describe('the venue on the game info tab', () => {
  it('shows the picture, held at its own size, and never before somebody asks for it', () => {
    const html = render(venue({ image: { href: interior.href, width: 2000, height: 1125, interior: true } }));
    expect(html).toContain(interior.href);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    // The dimensions are carried so the tab does not jump when a one to three megabyte picture lands.
    expect(html).toContain('width="2000"');
    expect(html).toContain('height="1125"');
  });

  it('describes it from what it is known to be, never from what is in it', () => {
    const inside = render(venue({ image: { href: interior.href, width: 2000, height: 1125, interior: true } }));
    expect(inside).toContain('alt="Inside Lambeau Field, photographed by the data provider"');
    const outside = render(venue({ image: { href: exterior.href, width: 2000, height: 1125, interior: false } }));
    expect(outside).toContain('alt="Lambeau Field, photographed by the data provider"');
    // The provider ships an empty alt for every one of them, which must never reach a screen reader.
    expect(inside).not.toContain('alt=""');
  });

  it('shows no picture at all for a venue the provider published none for', () => {
    expect(render(venue())).toBe('');
  });

  it('names the place under it, so a photograph is never unattributed', () => {
    const html = render(venue({ image: { href: interior.href, width: 2000, height: 1125, interior: true } }));
    expect(html).toContain('Lambeau Field');
    expect(html).toContain('Green Bay, WI');
  });

  it('shows nothing for a venue with a picture but no name, rather than an anonymous photograph', () => {
    expect(render(venue({ name: null, image: { href: interior.href, width: 2000, height: 1125, interior: true } }))).toBe('');
  });
});
