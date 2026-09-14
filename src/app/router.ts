/** A small history router: /, /focus, /wall, /game/:id and /team/:id, with shareable query parameters. Any other path is a not-found route. */
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { prefersReducedMotion } from '../lib/motion';

export type Route = { name: 'slate' } | { name: 'focus' } | { name: 'wall' } | { name: 'game'; id: string } | { name: 'team'; id: string } | { name: 'notFound' };

export interface AppLocation {
  route: Route;
  params: URLSearchParams;
  href: string;
  /** "party" when a watch party moved this tab here; null when the viewer or the browser did. */
  by: 'party' | null;
}

/** Query parameters that travel with navigation because they describe what is being watched. */
const STICKY = ['replay', 'date', 'party'];

/** A path segment, or null when it is not valid percent-encoding. */
function segment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function routeFor(pathname: string): Route {
  const game = /^\/game\/([^/]+)\/?$/.exec(pathname);
  const team = /^\/team\/([^/]+)\/?$/.exec(pathname);
  const gameId = game ? segment(game[1]) : null;
  const teamId = team ? segment(team[1]) : null;
  if (gameId !== null) return { name: 'game', id: gameId };
  if (teamId !== null) return { name: 'team', id: teamId };
  if (pathname === '/' || pathname === '/index.html') return { name: 'slate' };
  if (pathname === '/focus' || pathname === '/focus/') return { name: 'focus' };
  if (pathname === '/wall' || pathname === '/wall/') return { name: 'wall' };
  return { name: 'notFound' };
}

function parse(by: AppLocation['by'] = null): AppLocation {
  const { pathname, search } = window.location;
  return { route: routeFor(pathname), params: new URLSearchParams(search), href: pathname + search, by };
}

let current = parse();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    current = parse();
    notify();
  });
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'game':
      return `/game/${encodeURIComponent(route.id)}`;
    case 'team':
      return `/team/${encodeURIComponent(route.id)}`;
    case 'focus':
      return '/focus';
    case 'wall':
      return '/wall';
    case 'notFound':
      return window.location.pathname;
    default:
      return '/';
  }
}

export function navigate(route: Route, options: { replace?: boolean; params?: Record<string, string | null>; by?: 'party' } = {}) {
  const params = new URLSearchParams();
  for (const key of STICKY) {
    const v = current.params.get(key);
    if (v) params.set(key, v);
  }
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  const search = params.toString();
  const href = pathFor(route) + (search ? `?${search}` : '');
  if (href === current.href) return;
  const commit = () => {
    window.history[options.replace ? 'replaceState' : 'pushState'](null, '', href);
    current = parse(options.by ?? null);
    notify();
  };
  // Moving between views cross-fades through a view transition where the browser supports one.
  const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
  if (pathFor(route) !== window.location.pathname && typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    doc.startViewTransition(() => flushSync(commit));
  } else commit();
}

export function setParams(patch: Record<string, string | null>) {
  const params = new URLSearchParams(current.params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  const search = params.toString();
  const href = window.location.pathname + (search ? `?${search}` : '');
  if (href === current.href) return;
  window.history.replaceState(null, '', href);
  current = parse();
  notify();
}

export function useLocation(): AppLocation {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

/** Absolute URL for sharing. */
export function shareUrl(route: Route, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${window.location.origin}${pathFor(route)}${q ? `?${q}` : ''}`;
}

/** The current location outside React, for code that syncs with it (watch parties). */
export const getLocation = (): AppLocation => current;

/** Calls `listener` after every location change. */
export function subscribeLocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Team pages exist for provider team keys with numeric ids, such as nfl-2. */
export const isTeamPageId = (id: string) => /^(nfl|cfb)-\d{1,10}$/.test(id);

/** A plain click on an in-app link navigates without a page load; modified clicks keep the browser's behavior. */
export function linkClick(route: Route) {
  return (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number; preventDefault: () => void }) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(route);
  };
}
