/**
 * Code that loads on demand (the 3D layer, team pages, the watch party dialog) lives in hashed files that
 * disappear when a new version is deployed under an open page. A missing file reloads the page to pick up the
 * new version, at most once every ten minutes, so a file that stays unavailable (offline, say) cannot start a
 * reload loop; the caller then shows its own fallback.
 */
const RELOAD_KEY = 'gridiron.chunk-reload';
const RELOAD_GAP_MS = 10 * 60_000;

/** True for the errors browsers raise when a dynamically imported module cannot be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|importing a module script failed|error loading dynamically/i.test(message);
}

/** Reloads the page for a missing code file unless it reloaded for one recently. Returns true when the page is reloading. */
export function reloadForMissingChunk(error: unknown, now = Date.now()): boolean {
  if (!isChunkLoadError(error)) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (last > 0 && now - last < RELOAD_GAP_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
