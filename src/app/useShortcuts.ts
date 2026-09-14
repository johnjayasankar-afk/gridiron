/**
 * Keyboard shortcuts: Cmd/Ctrl+K palette, Esc to close or exit, 1/2/3 for
 * Slate/Focus/Wall, J/K and arrow keys between game cards, P to pin, F for
 * Focus, [ and ] between games, L for live, M for moments, ? for the list.
 * Single-key shortcuts are ignored while typing.
 */
import { useEffect } from 'react';
import { prefersReducedMotion } from '../lib/motion';
import { adjacentGameId } from '../state/navigation';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { navigate, useLocation } from './router';

export const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['⌘', 'K'], label: 'Search games, teams and commands (Ctrl+K on Windows and Linux)' },
  { keys: ['1'], label: 'Slate' },
  { keys: ['2'], label: 'Focus' },
  { keys: ['3'], label: 'Wall' },
  { keys: ['J', 'K'], label: 'Next or previous game card; arrow keys move across the grid once a card has focus' },
  { keys: ['P'], label: 'Pin or unpin the focused game' },
  { keys: ['F'], label: 'Add the focused game to Focus, or take it out' },
  { keys: ['[', ']'], label: 'Previous or next game on a game page' },
  { keys: ['L'], label: 'Back to live: live day on the slate, latest play on a game page' },
  { keys: ['M'], label: 'Show or hide moments' },
  { keys: ['?'], label: 'Keyboard shortcuts' },
  { keys: ['Esc'], label: 'Close a panel, leave the wall, or return to live' },
];

type Direction = 'up' | 'down' | 'left' | 'right';
const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

const cardOf = (el: Element | null) => el?.closest<HTMLElement>('.card[data-game]') ?? null;

function cardLinks(): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('.card[data-game] .card-link')].filter((el) => el.getClientRects().length > 0);
}

function focusCard(link: HTMLAnchorElement) {
  link.focus({ preventScroll: true });
  cardOf(link)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/** J and K: the next or previous card in reading order. */
function stepCard(step: 1 | -1): boolean {
  const links = cardLinks();
  if (!links.length) return false;
  const current = cardOf(document.activeElement);
  const index = current ? links.findIndex((l) => current.contains(l)) : -1;
  focusCard(links[index === -1 ? 0 : Math.min(links.length - 1, Math.max(0, index + step))]);
  return true;
}

/** Arrow keys: the nearest card in that direction on screen. Returns false when no card has focus. */
function moveCard(direction: Direction): boolean {
  const current = cardOf(document.activeElement);
  if (!current) return false;
  const from = current.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLAnchorElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const link of cardLinks()) {
    const card = cardOf(link);
    if (!card || card === current) continue;
    const r = card.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const along = direction === 'down' ? dy : direction === 'up' ? -dy : direction === 'right' ? dx : -dx;
    const across = direction === 'up' || direction === 'down' ? Math.abs(dx) : Math.abs(dy);
    if (along < 8) continue;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = link;
    }
  }
  if (best) focusCard(best);
  return true;
}

export function useShortcuts() {
  const { route } = useLocation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.setPalette(!ui.paletteOpen);
        return;
      }
      if (e.key === 'Escape') {
        if (ui.paletteOpen) ui.setPalette(false);
        else if (ui.dialog) ui.setDialog(null);
        else if (ui.drawerOpen) ui.setDrawer(false);
        else if (route.name === 'wall') {
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
          navigate({ name: 'slate' });
        } else if (ui.inspection && ui.inspection.order !== null) ui.patchInspection({ order: null, playing: false });
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || ui.paletteOpen || ui.dialog) return;

      const arrow = ARROWS[e.key];
      if (arrow) {
        if (!e.shiftKey && route.name !== 'game' && moveCard(arrow)) e.preventDefault();
        return;
      }

      const gameId = route.name === 'game' ? route.id : (cardOf(document.activeElement)?.dataset.game ?? null);
      switch (e.key) {
        case '1':
          navigate({ name: 'slate' });
          break;
        case '2':
          navigate({ name: 'focus' });
          break;
        case '3':
          navigate({ name: 'wall' });
          break;
        case 'j':
        case 'J':
          if (route.name === 'game' || !stepCard(1)) return;
          break;
        case 'k':
        case 'K':
          if (route.name === 'game' || !stepCard(-1)) return;
          break;
        case 'p':
        case 'P': {
          if (!gameId) return;
          const pinned = usePrefs.getState().pinned.includes(gameId);
          usePrefs.getState().togglePin(gameId);
          ui.showNotice(pinned ? 'Unpinned' : 'Pinned to the top');
          break;
        }
        case 'f':
        case 'F': {
          if (!gameId) return;
          const prefs = usePrefs.getState();
          const inFocus = prefs.focusGames.includes(gameId);
          if (inFocus) prefs.removeFromFocus(gameId);
          else prefs.addToFocus(gameId);
          ui.showNotice(inFocus ? 'Removed from focus' : 'Added to focus');
          break;
        }
        case '[':
        case ']': {
          if (route.name !== 'game') return;
          const next = adjacentGameId(route.id, e.key === ']' ? 1 : -1);
          if (!next) return;
          navigate({ name: 'game', id: next });
          break;
        }
        case 'l':
        case 'L':
          if (route.name === 'game') ui.patchInspection({ order: null, playing: false });
          else usePrefs.getState().set({ dayMode: 'live', date: null });
          break;
        case 'm':
        case 'M':
          if (window.matchMedia('(min-width: 1280px)').matches) usePrefs.getState().set({ railOpen: !usePrefs.getState().railOpen });
          else ui.setDrawer(!ui.drawerOpen);
          break;
        case '?':
          ui.setDialog('shortcuts');
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route]);
}
