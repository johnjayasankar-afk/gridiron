import type { GameSummary } from '../../../shared/model';

/**
 * The provider's own photograph of the arena this game is being played in.
 *
 * Every field Gridiron draws is a schematic, deliberately: the real orientation
 * of a stadium is not reported and its shape is not either, so the field says
 * what it knows and nothing more. That leaves one honest way to show the actual
 * place, which is the actual picture of it, and the provider publishes one for
 * most venues.
 *
 * It is here, behind a tab, rather than beside the field. The provider serves
 * these at full size and ignores any request to resize, so they run from one to
 * three megabytes; on the game page proper that would be a cost every viewer
 * pays for something most of them are not looking at. Behind a tab, lazily, with
 * the space held by the dimensions the provider gives, it costs nothing until
 * somebody asks for it.
 *
 * The provider ships an empty alt for all of them, so the description here is
 * written from what the picture is known to be, which is the venue and whether
 * it was taken inside the bowl. Nothing describes what is in the photograph,
 * because nothing here has looked at it.
 */
export function VenuePhoto({ venue }: { venue: NonNullable<GameSummary['venue']> }) {
  const image = venue.image;
  if (!image || !venue.name) return null;
  const where = [venue.city, venue.state].filter(Boolean).join(', ');
  return (
    <figure className="venue-photo">
      <img
        src={image.href}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
        alt={image.interior ? `Inside ${venue.name}, photographed by the data provider` : `${venue.name}, photographed by the data provider`}
      />
      <figcaption>
        {venue.name}
        {where ? ` · ${where}` : ''}
      </figcaption>
    </figure>
  );
}
