/**
 * Who may put this app in an iframe, and how it tells them it rendered.
 *
 * The portfolio shows a live preview of this product inside a case study. That
 * only works if the response allows the portfolio's origin to frame it, so the
 * allowlist lives here and both the Vercel headers and the Node server read it,
 * rather than each carrying its own copy that can drift.
 *
 * The handshake exists because the embedding page cannot tell a blocked frame
 * from a loaded cross-origin one. Both fire `load`, and everything else about
 * the frame is opaque to the parent by design. So a blocked embed used to
 * render as a black rectangle under a caption claiming a working app. The
 * embedding page now shows a still by default and only reveals the frame when
 * this message arrives, which a blocked frame can never send because its
 * scripts never run.
 */

/** Origins allowed to frame this app, beyond itself. */
export const EMBED_PARENTS = [
  'https://johnjayasankar.com',
  'https://labs.johnjayasankar.com',
] as const;

/** The `frame-ancestors` value for the Content-Security-Policy. */
export const FRAME_ANCESTORS = ["'self'", ...EMBED_PARENTS].join(' ');

/** What the embedding page listens for. Kept in one place across the products. */
export const EMBED_READY = 'embed:ready';

/** A loopback parent, so the embed can be driven locally while it is built. */
function isLoopback(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Tell a parent that framed us that we rendered. Safe to call unconditionally:
 * it does nothing outside a frame, and it posts only to a referrer on the
 * allowlist, so nothing is broadcast to an unknown origin.
 */
export function announceEmbed(win: Window = window): void {
  if (win.parent === win) return;
  let parentOrigin = '';
  try {
    parentOrigin = new URL(win.document.referrer).origin;
  } catch {
    return;
  }
  if (!(EMBED_PARENTS as readonly string[]).includes(parentOrigin)
      && !isLoopback(parentOrigin)) return;
  win.parent.postMessage({ type: EMBED_READY, from: win.location.origin }, parentOrigin);
}
