import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PushStore, STORE_FILE } from '../server/push/store';
import { generateVapidKeys } from '../server/push/webpush';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gridiron-push-store-'));
  dirs.push(dir);
  return dir;
};
const keys = () => ({ p256dh: generateVapidKeys().publicKey, auth: randomBytes(16).toString('base64url') });
const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/test-${n}`;
const input = (n: number, over: Record<string, unknown> = {}) => ({ endpoint: endpoint(n), keys: keys(), teams: ['nfl-2'], kinds: ['touchdown'], ...over });

describe('PushStore', () => {
  it('adds, updates and removes subscriptions from validated input only', () => {
    const store = new PushStore({ cacheDir: null });
    const added = store.upsert(input(1));
    expect(added).toMatchObject({ ok: true, created: true });
    expect(store.teams()).toEqual(['nfl-2']);

    const updated = store.upsert(input(1, { teams: ['nfl-2', 'cfb-333', 'nfl-2'], kinds: ['final', 'touchdown'] }));
    expect(updated).toMatchObject({ ok: true, created: false });
    expect(store.size).toBe(1);
    expect(store.teams()).toEqual(['cfb-333', 'nfl-2']);
    expect(store.get(endpoint(1))?.kinds).toEqual(['final', 'touchdown']);

    expect(store.upsert(input(2, { keys: { p256dh: 'short', auth: randomBytes(16).toString('base64url') } }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(store.upsert(input(2, { endpoint: 'https://push.elsewhere.example/abc' }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(store.upsert(input(2, { teams: [] }))).toMatchObject({ ok: false, error: 'Choose at least one team' });
    expect(store.upsert(input(2, { teams: ['nfl-BUF'] }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(store.upsert(input(2, { kinds: ['everything'] }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(store.size).toBe(1);

    expect(store.remove(endpoint(1))).toBe(true);
    expect(store.remove(endpoint(1))).toBe(false);
    expect(store.teams()).toEqual([]);
  });

  it('refuses new endpoints beyond its limit but still updates existing ones', () => {
    const store = new PushStore({ cacheDir: null, maxSubscriptions: 2 });
    expect(store.upsert(input(1)).ok).toBe(true);
    expect(store.upsert(input(2)).ok).toBe(true);
    expect(store.upsert(input(3))).toMatchObject({ ok: false, reason: 'full' });
    expect(store.upsert(input(2, { teams: ['cfb-333'] })).ok).toBe(true);
  });

  it('saves owner-only JSON and reloads only records that validate', async () => {
    const dir = tempDir();
    const store = new PushStore({ cacheDir: dir, debounceMs: 5 });
    store.upsert(input(1));
    store.upsert(input(2, { teams: ['cfb-333'] }));
    await store.flush();
    const file = join(dir, STORE_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; subscriptions: Array<Record<string, unknown>> };
    expect(saved.version).toBe(1);
    expect(saved.subscriptions).toHaveLength(2);

    const bad = { ...saved.subscriptions[1], teams: ['not a team'] };
    writeFileSync(file, JSON.stringify({ version: 1, subscriptions: [saved.subscriptions[0], bad] }));
    const logs: string[] = [];
    const reloaded = new PushStore({ cacheDir: dir, log: (m) => logs.push(m) });
    expect(reloaded.size).toBe(1);
    expect(reloaded.get(endpoint(1))?.teams).toEqual(['nfl-2']);
    expect(logs.join(' ')).toMatch(/dropped 1 saved push subscription/);

    writeFileSync(file, '{ not json');
    expect(new PushStore({ cacheDir: dir, log: () => {} }).size).toBe(0);
  });

  it('moves teams and kinds to a replacement subscription', () => {
    const store = new PushStore({ cacheDir: null });
    store.upsert(input(1, { teams: ['nfl-2', 'nfl-12'], kinds: ['final'] }));
    const next = { endpoint: endpoint(9), keys: keys() };
    expect(store.transfer(endpoint(1), next)).toMatchObject({ ok: true });
    expect(store.get(endpoint(1))).toBeNull();
    expect(store.get(endpoint(9))).toMatchObject({ teams: ['nfl-2', 'nfl-12'], kinds: ['final'] });
    expect(store.transfer(endpoint(1), next)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('counts refusals in a row and clears them on success', () => {
    const store = new PushStore({ cacheDir: null });
    store.upsert(input(1));
    expect(store.markFailure(endpoint(1))).toBe(1);
    expect(store.markFailure(endpoint(1))).toBe(2);
    store.markSuccess(endpoint(1), 123);
    expect(store.get(endpoint(1))).toMatchObject({ failures: 0, lastSuccessAt: 123 });
    expect(store.markFailure(endpoint(404))).toBe(0);
  });
});
