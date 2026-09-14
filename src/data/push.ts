/**
 * Web Push in the browser: whether this device can get alerts, and turning
 * them on, keeping them in step with favorite teams, testing them and turning
 * them off. The server receives only the push subscription and the teams and
 * alert kinds chosen.
 */
import type { AlertKind, TeamKey } from '../../shared/model';
import { ApiError, getJson, postJson } from './api';

export interface PushKeyInfo {
  available: boolean;
  publicKey?: string;
  reason?: string;
  kinds: AlertKind[];
  defaults: AlertKind[];
  maxTeams: number;
}

export type PushSupport = { supported: true; permission: NotificationPermission } | { supported: false; reason: string };
export type PushOutcome = { ok: true } | { ok: false; reason: string };

const isAppleMobile = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** The service worker registration, or null when none becomes ready (development builds register none). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))]);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function pushSupport(): Promise<PushSupport> {
  if (!('serviceWorker' in navigator) || typeof Notification === 'undefined' || !('PushManager' in window)) {
    if (isAppleMobile() && !isStandalone()) return { supported: false, reason: 'On iPhone and iPad, add Gridiron to your Home Screen first, then turn on alerts from there.' };
    return { supported: false, reason: 'This browser does not support push notifications.' };
  }
  if (Notification.permission === 'denied') return { supported: false, reason: 'Notifications are blocked for this site. Allow them in your browser settings to get alerts.' };
  if (!(await registration())) return { supported: false, reason: 'Push alerts need the app shell that the production build installs. This looks like a development build.' };
  return { supported: true, permission: Notification.permission };
}

export const fetchPushKey = () => getJson<PushKeyInfo>('/api/push/key');

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

const reasonOf = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : `${fallback}: ${(e as Error).message}`);

/** Asks for permission if needed, subscribes this browser and tells the server which teams and kinds it wants. */
export async function enablePush(teams: TeamKey[], kinds: AlertKind[]): Promise<PushOutcome> {
  const support = await pushSupport();
  if (!support.supported) return { ok: false, reason: support.reason };
  let key: PushKeyInfo;
  try {
    key = await fetchPushKey();
  } catch (e) {
    return { ok: false, reason: reasonOf(e, 'The server did not answer') };
  }
  if (!key.available || !key.publicKey) return { ok: false, reason: key.reason ?? 'Push alerts are not available on this server.' };
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: permission === 'denied' ? 'Notifications are blocked for this site.' : 'Notifications were not allowed.' };
  const reg = await registration();
  if (!reg) return { ok: false, reason: 'The app shell is not ready yet. Reload the page and try again.' };
  try {
    let subscription = await reg.pushManager.getSubscription();
    // A subscription made for another server key cannot receive this server's messages.
    if (subscription && !sameKey(subscription, key.publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.publicKey) });
    await postJson('/api/push/subscribe', { subscription: subscription.toJSON(), teams, kinds });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: reasonOf(e, 'This browser could not subscribe') };
  }
}

/** Sends the current teams and kinds for an existing subscription. 'off' when the browser holds none any more. */
export async function syncPush(teams: TeamKey[], kinds: AlertKind[]): Promise<'synced' | 'off' | { error: string }> {
  const subscription = await currentSubscription();
  if (!subscription) return 'off';
  try {
    await postJson('/api/push/subscribe', { subscription: subscription.toJSON(), teams, kinds });
    return 'synced';
  } catch (e) {
    return { error: reasonOf(e, 'The server did not answer') };
  }
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe().catch(() => false);
  await postJson('/api/push/unsubscribe', { endpoint }).catch(() => undefined);
}

export async function sendTestPush(): Promise<PushOutcome> {
  const subscription = await currentSubscription();
  if (!subscription) return { ok: false, reason: 'Push alerts are not on in this browser.' };
  try {
    await postJson('/api/push/test', { endpoint: subscription.endpoint });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: reasonOf(e, 'The server did not answer') };
  }
}
