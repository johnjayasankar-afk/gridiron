/** Small JSON helpers and the replay lab API. */
import type { ProviderInfoLite } from './transport';

export class ApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  } catch (e) {
    throw new ApiError(`Network error: ${(e as Error).message}`, null);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown, init: RequestInit = {}): Promise<T> {
  return getJson<T>(url, { ...init, method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

export interface Health {
  ok: boolean;
  version: string;
  mode: 'live' | 'replay';
  transport: 'sse' | 'poll';
  provider: ProviderInfoLite;
  today: string;
  serverTime: string;
  replayAvailable: boolean;
}

export interface ReplayScenario {
  id: string;
  label: string;
  description: string;
  synthetic: boolean;
  date: string;
}

export interface ReplayStatus {
  id: string;
  scenario: string;
  label: string;
  description: string;
  synthetic: boolean;
  date: string;
  limitations: string[];
  playing: boolean;
  speed: number;
  virtualTime: string;
  progress: number;
  start: string;
  end: string;
  outage: boolean;
}

export type ReplayCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; speed: number }
  | { type: 'step'; seconds: number }
  | { type: 'seek'; progress: number }
  | { type: 'outage'; seconds: number };

export const replayApi = {
  scenarios: () => getJson<{ scenarios: ReplayScenario[] }>('/api/replay/scenarios'),
  create: (scenario: string, options: { progress?: number; speed?: number; playing?: boolean } = {}) =>
    postJson<{ id: string; scenario: string; label: string }>('/api/replay/sessions', { scenario, ...options }),
  control: (id: string, command: ReplayCommand) => postJson<ReplayStatus>(`/api/replay/s/${id}/control`, command),
  status: (id: string) => getJson<ReplayStatus>(`/api/replay/s/${id}/status`),
};
