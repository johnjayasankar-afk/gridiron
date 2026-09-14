/**
 * Watch parties in this tab. A host's view (route, focused games, data source,
 * inspected play, spoiler delay, day and league) is sent to the party as it
 * changes. A guest applies the host's view while following, stops following
 * as soon as they move to another page on their own, and gets their own
 * settings back when they leave.
 */
import { useEffect } from 'react';
import { parseGameId } from '../../shared/model';
import { isDateKey } from '../../shared/util';
import { ApiError, replayApi } from '../data/api';
import { followParty, partyApi, type PartyState, type PartyView } from '../data/party';
import { useLive } from '../state/live';
import { EMPTY_PARTY, saveHostToken, savedHostToken, usePartyStore } from '../state/party';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { getLocation, navigate, setParams, subscribeLocation, useLocation, type AppLocation, type Route } from './router';
import { buildInterest } from './useConnection';

const PARTY_ID = /^[a-zA-Z0-9-]{8,64}$/;
const TEAM_ROUTE = /^(nfl|cfb)-\d{1,6}$/;
const PLAY_ID = /^[\w:.-]{1,64}$/;
const GUEST_PREFS_KEY = 'gridiron.party.guest-prefs';

let stopStream: (() => void) | null = null;
/** Until this moment, query parameter changes come from pages settling after the host's view was applied, not from the guest exploring. */
let applyingUntil = 0;

/** The page a route shows, whatever its query parameters. */
const pageOf = (route: Route) => ('id' in route ? `${route.name}:${route.id}` : route.name);

/** This tab's view, in the shape a party carries. */
export function currentPartyState(): PartyState {
  const { route, params } = getLocation();
  const p = usePrefs.getState();
  const source = useLive.getState().source;
  const partyRoute: PartyState['route'] =
    route.name === 'game' && parseGameId(route.id)
      ? { name: 'game', id: route.id }
      : route.name === 'team' && TEAM_ROUTE.test(route.id)
        ? { name: 'team', id: route.id }
        : route.name === 'focus' || route.name === 'wall'
          ? { name: route.name, id: null }
          : { name: 'slate', id: null };
  const play = params.get('play');
  return {
    route: partyRoute,
    focusGames: p.focusGames.filter((g) => parseGameId(g) !== null).slice(0, 4),
    source: source.kind === 'replay' ? { kind: 'replay', sessionId: source.sessionId } : { kind: 'live' },
    inspection: partyRoute.name === 'game' && partyRoute.id && play && PLAY_ID.test(play) ? { gameId: partyRoute.id, playId: play } : null,
    delaySeconds: Math.min(300, Math.max(0, Math.round(p.delaySeconds))),
    date: p.dayMode === 'date' && isDateKey(p.date) ? p.date : null,
    league: p.league,
  };
}

function routeOf(state: PartyState): Route {
  const r = state.route;
  if ((r.name === 'game' || r.name === 'team') && r.id) return { name: r.name, id: r.id };
  if (r.name === 'focus' || r.name === 'wall') return { name: r.name };
  return { name: 'slate' };
}

function matchesView(loc: AppLocation, state: PartyState): boolean {
  const want = routeOf(state);
  const haveId = 'id' in loc.route ? loc.route.id : null;
  const wantId = 'id' in want ? want.id : null;
  if (loc.route.name !== want.name || haveId !== wantId) return false;
  return want.name !== 'game' || (loc.params.get('play') ?? null) === (state.inspection?.playId ?? null);
}

function saveGuestPrefs() {
  const p = usePrefs.getState();
  try {
    if (!sessionStorage.getItem(GUEST_PREFS_KEY)) sessionStorage.setItem(GUEST_PREFS_KEY, JSON.stringify({ focusGames: p.focusGames, league: p.league, dayMode: p.dayMode, date: p.date, delaySeconds: p.delaySeconds }));
  } catch {
    // Without storage, leaving keeps the host's last settings.
  }
}

function restoreGuestPrefs() {
  let saved: unknown = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(GUEST_PREFS_KEY) ?? 'null');
    sessionStorage.removeItem(GUEST_PREFS_KEY);
  } catch {
    return;
  }
  if (!saved || typeof saved !== 'object') return;
  const s = saved as { focusGames?: unknown; league?: unknown; dayMode?: unknown; date?: unknown; delaySeconds?: unknown };
  const p = usePrefs.getState();
  const dated = s.dayMode === 'date' && isDateKey(s.date);
  p.set({
    focusGames: Array.isArray(s.focusGames) ? s.focusGames.filter((g): g is string => typeof g === 'string' && parseGameId(g) !== null).slice(0, 4) : p.focusGames,
    league: s.league === 'all' || s.league === 'nfl' || s.league === 'cfb' ? s.league : p.league,
    dayMode: dated ? 'date' : s.dayMode === 'live' || s.dayMode === 'today' ? s.dayMode : p.dayMode,
    date: dated ? (s.date as string) : null,
  });
  if (typeof s.delaySeconds === 'number') p.setDelay(s.delaySeconds);
}

async function applyView(view: PartyView) {
  const party = () => usePartyStore.getState();
  if (party().role !== 'guest' || !party().following) return;
  const state = view.state;
  applyingUntil = Date.now() + 1_500;
  // The data source first: into the host's replay session, or back to live.
  const live = useLive.getState();
  try {
    if (state.source.kind === 'replay' && (live.source.kind !== 'replay' || live.source.sessionId !== state.source.sessionId)) {
      const session = await replayApi.status(state.source.sessionId);
      await useLive.getState().connect({ kind: 'replay', sessionId: session.id, scenario: session.scenario, label: session.label }, buildInterest(routeOf(state)));
    } else if (state.source.kind === 'live' && live.source.kind === 'replay') {
      await useLive.getState().connect({ kind: 'live' }, buildInterest(routeOf(state)));
    }
  } catch (e) {
    party().set({ error: `The host's replay could not be joined: ${(e as Error).message}` });
  }
  if (party().role !== 'guest' || !party().following || party().view !== view) return;
  applyingUntil = Date.now() + 1_500;
  const p = usePrefs.getState();
  p.set({ focusGames: state.focusGames, league: state.league, ...(state.date ? { dayMode: 'date' as const, date: state.date } : p.dayMode === 'date' ? { dayMode: 'live' as const, date: null } : {}) });
  if (p.delaySeconds !== state.delaySeconds) p.setDelay(state.delaySeconds);
  const play = state.inspection?.playId ?? null;
  navigate(routeOf(state), { params: { play, date: state.date, replay: null }, by: 'party' });
  if (!play) {
    const ui = useUi.getState();
    if (ui.inspection && ui.inspection.order !== null) ui.patchInspection({ order: null, playing: false, driveId: null });
  }
}

function connectStream() {
  stopStream?.();
  stopStream = null;
  const { id, role } = usePartyStore.getState();
  if (!id || !role) return;
  const current = () => usePartyStore.getState().id === id;
  stopStream = followParty(
    id,
    (event) => {
      if (!current()) return;
      const party = usePartyStore.getState();
      if (event.type === 'members') party.set({ members: event.members });
      else if (event.type === 'state') {
        party.set({ view: event.view, members: event.view.members });
        if (party.role === 'guest' && party.following) void applyView(event.view);
      } else party.set({ status: 'ended', error: null });
    },
    (status, error) => {
      if (!current()) return;
      usePartyStore.getState().set(status === 'ended' ? { status: 'ended', error: null } : { status, error: error ?? usePartyStore.getState().error });
    },
  );
}

export async function startParty() {
  const party = usePartyStore.getState();
  if (party.role) return;
  party.set({ status: 'starting', error: null });
  try {
    const created = await partyApi.create(currentPartyState());
    saveHostToken(created.id, created.hostToken);
    usePartyStore.getState().set({ role: 'host', id: created.id, hostToken: created.hostToken, view: created.view, members: created.view.members, status: 'connecting', following: true, error: null });
    setParams({ party: created.id });
  } catch (e) {
    usePartyStore.getState().set({ status: 'error', error: (e as Error).message });
  }
}

export function leaveParty(clearLink = true) {
  stopStream?.();
  stopStream = null;
  const { role } = usePartyStore.getState();
  if (role === 'guest') {
    restoreGuestPrefs();
    const live = useLive.getState();
    if (live.source.kind === 'replay' && !getLocation().params.get('replay')) void live.connect({ kind: 'live' }, buildInterest(getLocation().route));
  }
  saveHostToken(null, null);
  usePartyStore.getState().set(EMPTY_PARTY);
  if (clearLink) setParams({ party: null });
}

export async function endParty() {
  const { role, id, hostToken } = usePartyStore.getState();
  if (role === 'host' && id && hostToken) await partyApi.end(id, hostToken).catch(() => undefined);
  leaveParty();
}

export function followHost(following: boolean) {
  const party = usePartyStore.getState();
  party.set({ following });
  if (following && party.view) void applyView(party.view);
}

export function usePartySync() {
  const { params } = useLocation();
  const partyParam = params.get('party');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sent = '';

    // Hosts: send the view shortly after it changes. The hub accepts a few updates a second.
    const publish = () => {
      const party = usePartyStore.getState();
      if (party.role !== 'host' || party.status === 'ended') return;
      if (JSON.stringify(currentPartyState()) === sent || timer) return;
      timer = setTimeout(() => {
        timer = null;
        const host = usePartyStore.getState();
        if (host.role !== 'host' || !host.id || !host.hostToken) return;
        const state = currentPartyState();
        const json = JSON.stringify(state);
        if (json === sent) return;
        sent = json;
        partyApi.update(host.id, host.hostToken, state).then(
          (view) => {
            if (usePartyStore.getState().id === host.id) usePartyStore.getState().set({ view, error: null });
          },
          (e: unknown) => {
            if (usePartyStore.getState().id !== host.id) return;
            if (e instanceof ApiError && (e.status === 404 || e.status === 403)) usePartyStore.getState().set({ status: 'ended', error: null });
            else {
              sent = '';
              usePartyStore.getState().set({ error: `Your view could not be sent to the party: ${(e as Error).message}` });
            }
          },
        );
      }, 250);
    };

    // Guests: moving to another page on their own means exploring, however soon after the host moved. Moves the
    // party made are marked, so they never count, even when a view transition lands them late. Query parameter
    // changes right after the host's view is applied are pages settling, so they do not count either.
    let lastPage = pageOf(getLocation().route);
    const explore = () => {
      const location = getLocation();
      const page = pageOf(location.route);
      const moved = page !== lastPage;
      lastPage = page;
      const party = usePartyStore.getState();
      if (location.by === 'party' || party.role !== 'guest' || !party.following || !party.view) return;
      if (!moved && Date.now() < applyingUntil) return;
      if (!matchesView(location, party.view.state)) {
        party.set({ following: false });
        useUi.getState().showNotice('Exploring on your own. Follow the host again from the party banner.');
      }
    };

    const offParty = usePartyStore.subscribe((s, p) => {
      if (s.id !== p.id || s.role !== p.role) {
        sent = '';
        connectStream();
      }
      publish();
    });
    const offLocation = subscribeLocation(() => {
      publish();
      explore();
    });
    const offPrefs = usePrefs.subscribe(publish);
    const offLive = useLive.subscribe((s, p) => {
      if (s.source !== p.source) publish();
    });
    if (usePartyStore.getState().role) connectStream();
    return () => {
      offParty();
      offLocation();
      offPrefs();
      offLive();
      if (timer) clearTimeout(timer);
      stopStream?.();
      stopStream = null;
    };
  }, []);

  // A party link joins as a guest; the host's own tab, holding its token, resumes hosting after a reload.
  useEffect(() => {
    if (!partyParam || !PARTY_ID.test(partyParam)) return;
    const party = usePartyStore.getState();
    if (party.id === partyParam) return;
    if (party.role) leaveParty(false);
    const token = savedHostToken(partyParam);
    if (token) {
      usePartyStore.getState().set({ ...EMPTY_PARTY, role: 'host', id: partyParam, hostToken: token, status: 'connecting' });
    } else {
      saveGuestPrefs();
      usePartyStore.getState().set({ ...EMPTY_PARTY, role: 'guest', id: partyParam, status: 'connecting' });
    }
  }, [partyParam]);
}
