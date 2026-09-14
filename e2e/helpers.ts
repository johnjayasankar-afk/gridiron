import { expect, type Page } from '@playwright/test';

export interface ReplayOptions {
  scenario?: string;
  /** Replay position, 0 to 1. */
  at?: number;
  /** Paused by default so tests are deterministic. */
  paused?: boolean;
  speed?: number;
  path?: string;
  extra?: Record<string, string>;
}

/** Opens a page on its own replay session and returns the session id. */
export async function openReplay(page: Page, options: ReplayOptions = {}): Promise<string> {
  const params = new URLSearchParams({ replay: options.scenario ?? 'nfl-week1-sunday', ...options.extra });
  if (options.at !== undefined) params.set('at', String(options.at));
  if (options.paused !== false) params.set('paused', '1');
  if (options.speed) params.set('speed', String(options.speed));
  const created = page.waitForResponse((r) => r.url().includes('/api/replay/sessions') && r.request().method() === 'POST');
  await page.goto(`${options.path ?? '/'}?${params}`);
  const session = (await (await created).json()) as { id: string };
  await expect(page.locator('.replay-bar')).toBeVisible();
  return session.id;
}

export async function control(page: Page, sessionId: string, command: Record<string, unknown>) {
  const res = await page.request.post(`/api/replay/s/${sessionId}/control`, { data: command });
  expect(res.ok(), `replay control ${JSON.stringify(command)}`).toBeTruthy();
  return res.json();
}

/** Seeds persisted preferences before the app loads. */
export async function seedPrefs(page: Page, state: Record<string, unknown>) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem('gridiron.e2e.seeded')) return;
    localStorage.setItem('gridiron.prefs.v1', JSON.stringify({ state: s, version: 1 }));
    sessionStorage.setItem('gridiron.e2e.seeded', '1');
  }, state);
}

export const liveCards = (page: Page) => page.locator('.section-live .card');

export async function openMenuItem(page: Page, item: string) {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** The page never scrolls sideways. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
