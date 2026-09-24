import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { ConnectionBanner, DelayBanner, GraphicsNotice, PartyBanner, ReplayBar, SharedBoardPrompt } from '../components/Banners';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { MomentsRail } from '../components/MomentsRail';
import { PopoutHost } from '../components/Popout';
import { LiveRegion, Toasts } from '../components/Toasts';
import { ViewBoundary } from '../components/ViewBoundary';
import { AtmosphereCanvas } from '../fx/Atmosphere';
import { Boot } from '../fx/Boot';
import { installSpotlight } from '../fx/spotlight';
import { reloadForMissingChunk } from '../lib/chunks';
import { lazyWithPreload, preloadWhenIdle } from '../lib/lazyView';
import { prefersReducedMotion } from '../lib/motion';
import { unlockSound } from '../lib/sound';
import { useResolvedTheme } from '../lib/theme';
import { useFieldMode, useGraphics } from '../state/graphics';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { FocusView } from '../views/FocusView';
import { NotFoundView } from '../views/NotFoundView';
import { SlateView } from '../views/SlateView';
import { TeamPageLoading } from '../views/TeamLoading';
import { WallView } from '../views/WallView';
import { navigate, useLocation } from './router';
import { useAlerts } from './useAlerts';
import { useTapeRecorder } from './useTape';
import { useConnection } from './useConnection';
import { useDigestDriver } from './useDigest';
import { useDirectorDriver } from './useDirector';
import { usePartySync } from './usePartySync';
import { usePushSync } from './usePushSync';
import { useShortcuts } from './useShortcuts';

/** The shared WebGL canvas and three.js load as their own chunk, only when fields are drawn in 3D. */
const FieldCanvas = lazy(() => import('../field/FieldCanvas').then((m) => ({ default: m.FieldCanvas })));
/** Team pages load their own code the first time one opens. */
const TeamView = lazy(() => import('../views/TeamView').then((m) => ({ default: m.TeamView })));
/** So does the watch party dialog, with its QR code encoder. */
const PartyDialog = lazy(() => import('../components/PartyDialog').then((m) => ({ default: m.PartyDialog })));
/**
 * The game page, the settings dialogs and the command palette load on first use too, but their code is
 * fetched once the page is idle, so they are ready before anyone opens them.
 */
const DetailView = lazyWithPreload(() => import('../views/DetailView').then((m) => m.DetailView));
// The tape is a whole view most visits never open, so its code waits like the
// game page's does. The RECORDER is not lazy: it has to be running from the
// moment the page is, or the tape would only begin when somebody looked at it.
const TapeView = lazyWithPreload(() => import('../views/TapeView').then((m) => m.TapeView));
const Dialogs = lazyWithPreload(() => import('../components/dialogs').then((m) => m.Dialogs));
const CommandPalette = lazyWithPreload(() => import('../components/CommandPalette').then((m) => m.CommandPalette));

/** If the 3D layer throws, fields fall back to 2D instead of taking the page down. */
class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    if (reloadForMissingChunk(error)) return;
    console.error('Gridiron: the 3D field layer failed and fields fell back to 2D.', error);
    useGraphics.getState().markLost();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** If a dialog's or the palette's code cannot load, it closes and says so instead of taking the page down. */
class LazyBoundary extends Component<{ what: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    if (reloadForMissingChunk(error)) return;
    console.error(`Gridiron: the ${this.props.what} could not load.`, error);
    const ui = useUi.getState();
    ui.setDialog(null);
    ui.setPalette(false);
    ui.showNotice(`The ${this.props.what} could not load. Reload the page to try again.`);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** True from the first time `value` is true: code-split UI stays mounted once opened, so it closes and returns focus as usual. */
function useOnceTrue(value: boolean): boolean {
  const [seen, setSeen] = useState(value);
  if (value && !seen) setSeen(true);
  return seen || value;
}

function PartyDialogSlot() {
  const needed = useOnceTrue(useUi((s) => s.dialog === 'party'));
  return needed ? (
    <LazyBoundary what="watch party dialog">
      <Suspense fallback={null}>
        <PartyDialog />
      </Suspense>
    </LazyBoundary>
  ) : null;
}

function DialogsSlot() {
  const needed = useOnceTrue(useUi((s) => s.dialog !== null && s.dialog !== 'party'));
  return needed ? (
    <LazyBoundary what="dialog">
      <Suspense fallback={null}>
        <Dialogs />
      </Suspense>
    </LazyBoundary>
  ) : null;
}

function PaletteSlot() {
  const needed = useOnceTrue(useUi((s) => s.paletteOpen));
  return needed ? (
    <LazyBoundary what="command palette">
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
    </LazyBoundary>
  ) : null;
}

function useTheme() {
  const theme = useResolvedTheme();
  useEffect(() => {
    const root = document.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Colours ease across a switch; the first paint (already themed by theme-init.js) does not animate.
    if (root.dataset.theme !== theme && !prefersReducedMotion()) {
      root.classList.add('theme-switching');
      timer = setTimeout(() => root.classList.remove('theme-switching'), 360);
    }
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#030806' : '#f8f6f1');
    return () => {
      if (timer) clearTimeout(timer);
      root.classList.remove('theme-switching');
    };
  }, [theme]);
}

/** The effects setting drives CSS motion (data-effects), and the pointer spotlight is installed once. */
function useSurfaceEffects() {
  const effects = usePrefs((s) => s.effects);
  useEffect(() => {
    document.documentElement.dataset.effects = effects;
  }, [effects]);
  useEffect(() => installSpotlight(), []);
}

function useSoundUnlock() {
  useEffect(() => {
    const unlock = () => {
      const p = usePrefs.getState();
      if (p.sound || p.fieldSound) void unlockSound();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
}

export function App() {
  useTheme();
  useSurfaceEffects();
  useConnection();
  usePartySync();
  usePushSync();
  useAlerts();
  useTapeRecorder();
  useDirectorDriver();
  useDigestDriver();
  useShortcuts();
  useSoundUnlock();
  const { route } = useLocation();
  const canvasKey = useGraphics((s) => s.canvasKey);
  const fieldMode = useFieldMode();
  const wall = route.name === 'wall';
  const routeKey = route.name === 'game' || route.name === 'team' ? `${route.name}:${route.id}` : route.name;
  const home = () => navigate({ name: 'slate' });

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [routeKey]);

  useEffect(() => preloadWhenIdle([DetailView.preload, Dialogs.preload, CommandPalette.preload, TapeView.preload]), []);

  return (
    <div className={`app route-${route.name}`}>
      <AtmosphereCanvas />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {!wall && <Header />}
      <ReplayBar />
      {!wall && (
        <div className="page-banners">
          <PartyBanner />
          <ConnectionBanner />
          <GraphicsNotice />
          <DelayBanner />
          <SharedBoardPrompt />
        </div>
      )}
      {wall ? (
        <ViewBoundary key={routeKey} onHome={home}>
          <WallView />
        </ViewBoundary>
      ) : (
        <div className="shell">
          <main id="main" className="main" tabIndex={-1}>
            <ViewBoundary key={routeKey} onHome={home}>
              {route.name === 'slate' && <SlateView />}
              {route.name === 'focus' && <FocusView />}
              {route.name === 'tape' && (
                <Suspense fallback={null}>
                  <TapeView />
                </Suspense>
              )}
              {route.name === 'game' && (
                <Suspense fallback={null}>
                  <DetailView key={route.id} id={route.id} />
                </Suspense>
              )}
              {route.name === 'team' && (
                <Suspense fallback={<TeamPageLoading />}>
                  <TeamView key={route.id} id={route.id} />
                </Suspense>
              )}
              {route.name === 'notFound' && <NotFoundView />}
            </ViewBoundary>
          </main>
          <MomentsRail />
        </div>
      )}
      {!wall && <Footer />}
      {fieldMode === '3d' && (
        <CanvasBoundary key={canvasKey}>
          <Suspense fallback={null}>
            <FieldCanvas />
          </Suspense>
        </CanvasBoundary>
      )}
      <Toasts />
      <DialogsSlot />
      <PartyDialogSlot />
      <PaletteSlot />
      <PopoutHost />
      <LiveRegion />
      <Boot />
    </div>
  );
}
