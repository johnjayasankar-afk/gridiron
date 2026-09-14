/**
 * Push alerts: the alert kinds a subscription can choose and the message a
 * service worker receives. Shared by the server and the browser.
 */
import type { AlertKind, GameId } from './model.js';

/** Alert kinds a subscription may choose. */
export const PUSH_KINDS: readonly AlertKind[] = [
  'touchdown', 'field_goal', 'safety', 'turnover', 'red_zone', 'fourth_down_attempt', 'big_play',
  'lead_change', 'tied', 'close_late', 'overtime', 'final', 'kickoff', 'score_change',
];

/** What a subscription gets when it does not choose. */
export const DEFAULT_PUSH_KINDS: readonly AlertKind[] = ['touchdown', 'field_goal', 'turnover', 'lead_change', 'close_late', 'overtime', 'final', 'kickoff'];

/** Team keys push alerts accept: the league and the provider's numeric team id, such as nfl-2. */
export const PUSH_TEAM_KEY = /^(nfl|cfb)-\d{1,6}$/;

/** What the service worker receives, as JSON. */
export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  /** The alert id: a correction replaces the notification it corrects. */
  tag: string;
  /** A path on this site. */
  url: string;
  gameId: GameId | null;
  kind: AlertKind | 'test';
  /** Epoch milliseconds: when the moment was observed (on the replay clock in a replay). */
  at: number;
  replay: boolean;
}
