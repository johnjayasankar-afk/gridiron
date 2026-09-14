/**
 * Watch party state for this tab: hosting, or following a host. The host token
 * is kept per tab in session storage, so a reload keeps hosting; nothing about a
 * party outlives the tab.
 */
import { create } from 'zustand';
import type { PartyView } from '../data/party';

export type PartyRole = 'host' | 'guest';
export type PartyStatus = 'idle' | 'starting' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error';

export interface PartyData {
  role: PartyRole | null;
  id: string | null;
  hostToken: string | null;
  /** The host's latest view. */
  view: PartyView | null;
  /** Everyone following the party's stream, the host included. */
  members: number;
  /** A guest applies the host's view while following, and explores on their own otherwise. */
  following: boolean;
  status: PartyStatus;
  error: string | null;
}

export const EMPTY_PARTY: PartyData = { role: null, id: null, hostToken: null, view: null, members: 0, following: true, status: 'idle', error: null };

export const usePartyStore = create<PartyData & { set: (patch: Partial<PartyData>) => void }>()((set) => ({
  ...EMPTY_PARTY,
  set: (patch) => set(patch),
}));

const TOKEN_KEY = 'gridiron.party.host';

export function savedHostToken(id: string): string | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as { id?: unknown; token?: unknown } | null;
    return raw?.id === id && typeof raw.token === 'string' ? raw.token : null;
  } catch {
    return null;
  }
}

export function saveHostToken(id: string | null, token: string | null) {
  try {
    if (id && token) sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ id, token }));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage is optional: without it a reload simply ends hosting in this tab.
  }
}
