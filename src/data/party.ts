/** Watch party API: start, update and end a party, and follow one over server-sent events. */
import type { PartyEvent, PartyState, PartyView } from '../../server/party';
import { ApiError, getJson, postJson } from './api';

export type { PartyEvent, PartyState, PartyView };

async function withToken<T>(method: 'PUT' | 'DELETE', url: string, token: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(`Network error: ${(e as Error).message}`, null);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

const path = (id: string) => `/api/party/${encodeURIComponent(id)}`;

export const partyApi = {
  create: (state: PartyState) => postJson<{ id: string; hostToken: string; view: PartyView }>('/api/party', { state }),
  view: (id: string) => getJson<PartyView>(path(id)),
  update: (id: string, token: string, state: PartyState) => withToken<PartyView>('PUT', path(id), token, { state }),
  end: (id: string, token: string) => withToken<{ ok: true }>('DELETE', path(id), token),
};

export type FollowStatus = 'connecting' | 'live' | 'reconnecting' | 'ended';

/**
 * Follows a party's stream. EventSource retries on its own; when it gives up,
 * the party is looked up once, so an ended party reads as ended rather than as
 * a network problem.
 */
export function followParty(id: string, onEvent: (event: PartyEvent) => void, onStatus: (status: FollowStatus, error?: string) => void): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
    source = null;
  };
  const handle = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(String(e.data)) as PartyEvent);
    } catch {
      // A malformed event is skipped; the next state event carries the whole view again.
    }
  };
  const open = () => {
    if (closed) return;
    onStatus('connecting');
    const es = new EventSource(`${path(id)}/stream`);
    source = es;
    es.addEventListener('open', () => onStatus('live'));
    es.addEventListener('state', handle);
    es.addEventListener('members', handle);
    es.addEventListener('ended', (e) => {
      handle(e);
      stop();
      onStatus('ended');
    });
    es.addEventListener('error', () => {
      if (closed || source !== es) return;
      if (es.readyState !== EventSource.CLOSED) {
        onStatus('reconnecting');
        return;
      }
      source = null;
      partyApi.view(id).then(
        () => {
          if (closed) return;
          onStatus('reconnecting');
          retry = setTimeout(open, 4_000);
        },
        (err: unknown) => {
          if (closed) return;
          if (err instanceof ApiError && err.status === 404) {
            closed = true;
            onStatus('ended');
          } else {
            onStatus('reconnecting', (err as Error).message);
            retry = setTimeout(open, 4_000);
          }
        },
      );
    });
  };
  open();
  return stop;
}
