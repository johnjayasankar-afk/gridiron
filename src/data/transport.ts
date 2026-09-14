/**
 * The client's connection to a Gridiron server.
 *
 * Server-sent events are the default: one stream per tab, carrying slate deltas
 * and detail for the games this tab has declared interest in. When the server
 * says it can only be polled (a serverless deployment), or the stream cannot be
 * opened, the same messages are produced by bounded polling instead.
 */
import type { DetailDelta } from '../../shared/detailDelta';
import type { CoverageReport, Division, Freshness, GameDetail, GameId, GameSummary, LeagueId, SlateSnapshot } from '../../shared/model';
import { ApiError, getJson, postJson } from './api';

export interface ProviderInfoLite {
  id: string;
  name: string;
  description: string;
  licensed: boolean;
  push: boolean;
  divisions: Division[];
}

export interface Hello {
  clientId: string;
  mode: 'live' | 'replay';
  replayLabel: string | null;
  replaySession: string | null;
  provider: ProviderInfoLite;
  today: string;
  serverTime: string;
}

export interface Interest {
  date: string | null;
  divisions: Division[];
  focus: GameId[];
  visible: GameId[];
  monitored: GameId[];
  alertsAllGames: boolean;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export type Incoming =
  | { type: 'hello'; hello: Hello }
  | { type: 'slate'; snapshot: SlateSnapshot }
  | { type: 'slate-delta'; date: string; seq: number; generatedAt: string; upserts: GameSummary[]; removed: GameId[]; freshness: Record<LeagueId, Freshness>; coverage: CoverageReport }
  | { type: 'detail'; gameId: GameId; version: number; detail: GameDetail | null; freshness: Freshness }
  | { type: 'detail-delta'; gameId: GameId; delta: DetailDelta; freshness: Freshness }
  | { type: 'detail-freshness'; gameId: GameId; version: number; freshness: Freshness }
  | { type: 'connection'; status: ConnectionStatus; transport: 'sse' | 'poll'; error: string | null }
  | { type: 'gap' };

const CLIENT_KEY = 'gridiron.client';

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function tabClientId(): string {
  try {
    let id = sessionStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = newId();
      sessionStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return newId();
  }
}

export interface TransportOptions {
  base: string;
  emit: (message: Incoming) => void;
  polling?: boolean;
}

export class Transport {
  private readonly clientId = tabClientId();
  private es: EventSource | null = null;
  private interest: Interest;
  private stopped = false;
  private everConnected = false;
  private failures = 0;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private postTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPosted = '';
  private poller: Poller | null = null;

  constructor(private readonly options: TransportOptions, interest: Interest) {
    this.interest = interest;
  }

  get mode(): 'sse' | 'poll' {
    return this.poller ? 'poll' : 'sse';
  }

  start() {
    if (this.options.polling || typeof EventSource === 'undefined') this.startPolling();
    else this.open();
  }

  stop() {
    this.stopped = true;
    this.es?.close();
    this.es = null;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    if (this.postTimer) clearTimeout(this.postTimer);
    this.poller?.stop();
  }

  setInterest(next: Interest) {
    const dateChanged = next.date !== this.interest.date;
    this.interest = next;
    if (this.poller) {
      this.poller.setInterest(next);
      return;
    }
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => void this.postInterest(), dateChanged ? 0 : 450);
  }

  /** Ask for a full copy of one game's detail (after a delta the client could not apply). */
  async refetchDetail(gameId: GameId) {
    try {
      const r = await getJson<{ version: number; detail: GameDetail | null; freshness: Freshness }>(`${this.options.base}/game/${encodeURIComponent(gameId)}`);
      this.options.emit({ type: 'detail', gameId, version: r.version, detail: r.detail, freshness: r.freshness });
    } catch {
      /* the next update or poll will try again */
    }
  }

  private async postInterest() {
    if (this.stopped || !this.everConnected) return;
    const payload = { clientId: this.clientId, interest: this.interest };
    const body = JSON.stringify(payload);
    if (body === this.lastPosted) return;
    try {
      await postJson(`${this.options.base}/interest`, payload);
      this.lastPosted = body;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) this.reopen(0);
    }
  }

  private open() {
    if (this.stopped) return;
    const i = this.interest;
    const q = new URLSearchParams({
      clientId: this.clientId,
      divisions: i.divisions.join(','),
      focus: i.focus.join(','),
      visible: i.visible.join(','),
      monitored: i.monitored.join(','),
      alertsAll: i.alertsAllGames ? '1' : '0',
    });
    if (i.date) q.set('date', i.date);
    this.options.emit({ type: 'connection', status: this.everConnected ? 'reconnecting' : 'connecting', transport: 'sse', error: null });
    const es = new EventSource(`${this.options.base}/stream?${q.toString()}`);
    this.es = es;
    es.addEventListener('hello', (ev) => {
      const hello = JSON.parse((ev as MessageEvent<string>).data) as Hello;
      if (this.everConnected) this.options.emit({ type: 'gap' });
      this.everConnected = true;
      this.failures = 0;
      this.lastPosted = JSON.stringify({ clientId: this.clientId, interest: this.interest });
      this.options.emit({ type: 'hello', hello });
      this.options.emit({ type: 'connection', status: 'connected', transport: 'sse', error: null });
      // Interest may have changed while the stream was opening.
      void this.postInterest();
    });
    for (const type of ['slate', 'slate-delta', 'detail', 'detail-delta', 'detail-freshness'] as const) {
      es.addEventListener(type, (ev) => {
        try {
          this.options.emit(JSON.parse((ev as MessageEvent<string>).data) as Incoming);
        } catch {
          /* a malformed message is ignored; the next delta or resync repairs state */
        }
      });
    }
    es.onerror = () => {
      if (this.stopped || this.es !== es) return;
      this.failures++;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      this.options.emit({ type: 'connection', status: offline ? 'offline' : 'reconnecting', transport: 'sse', error: 'The connection to the Gridiron server was interrupted.' });
      if (es.readyState === EventSource.CLOSED) {
        if (!this.everConnected && this.failures >= 3) this.startPolling();
        else this.reopen(Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5)));
      }
    };
  }

  private reopen(delayMs: number) {
    this.es?.close();
    this.es = null;
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => this.open(), delayMs);
  }

  private startPolling() {
    this.es?.close();
    this.es = null;
    this.poller = new Poller(this.options.base, this.interest, this.options.emit);
    this.poller.start();
  }
}

/** Bounded polling that produces the same messages as the stream. */
class Poller {
  private stopped = false;
  private slateTimer: ReturnType<typeof setTimeout> | null = null;
  private detailTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private everConnected = false;
  private versions = new Map<GameId, number>();
  private lastDetailAt = new Map<GameId, number>();

  constructor(private readonly base: string, private interest: Interest, private readonly emit: (m: Incoming) => void) {}

  start() {
    void this.pollSlate();
    this.detailTimer = setTimeout(() => void this.pollDetails(), 1_500);
  }

  stop() {
    this.stopped = true;
    if (this.slateTimer) clearTimeout(this.slateTimer);
    if (this.detailTimer) clearTimeout(this.detailTimer);
  }

  setInterest(next: Interest) {
    const dateChanged = next.date !== this.interest.date;
    this.interest = next;
    if (dateChanged) {
      if (this.slateTimer) clearTimeout(this.slateTimer);
      void this.pollSlate();
    }
  }

  private async pollSlate() {
    if (this.stopped) return;
    try {
      const date = this.interest.date;
      const snapshot = await getJson<SlateSnapshot>(`${this.base}/slate${date ? `?date=${date}` : ''}`);
      if (!this.everConnected) {
        this.emit({
          type: 'hello',
          hello: { clientId: 'poll', mode: snapshot.mode, replayLabel: snapshot.replayLabel, replaySession: null, provider: { id: 'server', name: snapshot.coverage.provider, description: '', licensed: false, push: false, divisions: [] }, today: snapshot.date, serverTime: snapshot.generatedAt },
        });
      } else if (this.failures > 0) this.emit({ type: 'gap' });
      this.everConnected = true;
      this.failures = 0;
      this.emit({ type: 'connection', status: 'connected', transport: 'poll', error: null });
      this.emit({ type: 'slate', snapshot });
    } catch (e) {
      this.failures++;
      this.emit({ type: 'connection', status: 'reconnecting', transport: 'poll', error: (e as Error).message });
    } finally {
      if (!this.stopped) this.slateTimer = setTimeout(() => void this.pollSlate(), this.failures ? Math.min(120_000, 25_000 * 2 ** Math.min(this.failures, 3)) : 25_000);
    }
  }

  private async pollDetails() {
    if (this.stopped) return;
    const now = Date.now();
    const due: GameId[] = [];
    for (const id of this.interest.focus) if (now - (this.lastDetailAt.get(id) ?? 0) >= 12_000) due.push(id);
    for (const id of [...this.interest.visible, ...this.interest.monitored]) if (!due.includes(id) && now - (this.lastDetailAt.get(id) ?? 0) >= 25_000) due.push(id);
    for (const id of due.slice(0, 4)) {
      this.lastDetailAt.set(id, now);
      try {
        const r = await getJson<{ version: number; detail: GameDetail | null; freshness: Freshness }>(`${this.base}/game/${encodeURIComponent(id)}`);
        if (this.versions.get(id) !== r.version || !r.detail) {
          this.versions.set(id, r.version);
          this.emit({ type: 'detail', gameId: id, version: r.version, detail: r.detail, freshness: r.freshness });
        } else {
          this.emit({ type: 'detail-freshness', gameId: id, version: r.version, freshness: r.freshness });
        }
      } catch {
        /* keep the last detail; freshness shows its age */
      }
    }
    if (!this.stopped) this.detailTimer = setTimeout(() => void this.pollDetails(), 3_000);
  }
}
