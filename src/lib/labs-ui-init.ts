/* Gridiron, in the Labs material.
 *
 * Glass on the masthead, the game cards and the segmented controls. The field
 * itself is left alone: a play diagram has to stay exact, and a WebGL canvas
 * cannot be a backdrop for one anyway.
 *
 * The app renders its own DOM as data arrives, so labs-ui watches for new nodes.
 */
// @ts-expect-error: labs-ui is plain JavaScript, shared across every Labs product
import { initLabsUI } from './labs-ui.js';

export function startLabsUI() {
  return initLabsUI({
    observe: true,
    glass: [
      { sel: '.hdr', spec: 1, lens: [13, 52, 9, 1.95], vars: { '--gl-tint': '.5', '--gl-tint-dark': '.56', '--gl-drop': '0 1px 0 rgba(28,51,38,.09)' } },
      /*
       * Cards wear FLAT glass: the tint and the rim, with no backdrop filter.
       *
       * A backdrop filter forms a stacking context, and every card contains a
       * field slot whose controls are meant to sit above the one shared WebGL
       * canvas. With the full material they went under it instead. Flat glass is
       * what this system already calls "what the small, numerous, moving pieces
       * wear", and a card over a live 3D field is exactly that: it also spares
       * the compositor thirteen backdrop filters over a canvas that is redrawing.
       */
      { sel: '.card', flat: true, vars: { '--gl-tint': '.6', '--gl-tint-dark': '.5' } },
      { sel: '.seg', spec: 1, lens: [8, 23, 4, 1.7], vars: { '--gl-tint': '.4', '--gl-tint-dark': '.44' } },
    ],
    /*
     * No word by word reveal on headings.
     *
     * It is a landing page flourish, and this is a live scoreboard: the section
     * headings sit below the fold at six per cent opacity until an observer
     * fires, which an accessibility audit reads, correctly, as text at 1.37:1.
     * A page whose content changes every fifteen seconds also pays for a span
     * per word every time a heading is rebuilt. The glass material stays; the
     * animation does not.
     */
  });
}
