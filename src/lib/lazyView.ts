/**
 * Views and dialogs that load their code on first use. Unlike React.lazy alone, a component whose
 * code was preloaded renders at once without suspending, so a page change inside a view transition
 * never paints an empty fallback first. Code missing after a new deploy is handled by the error
 * boundary around each use (see chunks.ts).
 */
import { createElement, lazy, type ComponentType } from 'react';

export type Preloadable<P extends object> = ComponentType<P> & { preload: () => Promise<unknown> };

export function lazyWithPreload<P extends object>(load: () => Promise<ComponentType<P>>): Preloadable<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = (): Promise<ComponentType<P>> => {
    pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        // A failed fetch can be tried again later.
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  const Loadable = (props: P) => (loaded ? createElement(loaded, props) : createElement(Lazy, props));
  return Object.assign(Loadable, { preload });
}

/** Fetches code that loads on first use once the page is idle, unless the visitor's browser asks to save data. */
export function preloadWhenIdle(preloads: Array<() => Promise<unknown>>): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => undefined;
  const run = () => {
    for (const preload of preloads) void preload().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 5_000 });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(run, 2_000);
  return () => window.clearTimeout(timer);
}
