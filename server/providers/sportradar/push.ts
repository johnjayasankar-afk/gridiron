/**
 * Sportradar push feed reader (production plans only).
 *
 * Documented behaviour (developer.sportradar.com, checked 2026-09-14): one GET
 * with the x-api-key header, follow the redirect, and keep the connection open.
 * The body is chunked with one JSON message per line. A heartbeat line
 * {"heartbeat":{"interval":5000}} arrives every 5 seconds. Event messages carry
 * payload.game, payload.event and metadata. There is no resume: after a
 * reconnect, missed plays must be backfilled from the REST play-by-play.
 *
 * This class only reads the stream. It parses lines across chunk boundaries,
 * treats any received data as liveness, reconnects after 20 seconds of silence
 * or any error with capped exponential back-off and jitter, and emits typed
 * events. Normalizing game data is the provider's job.
 */
import type { ApiKey } from './config.js';

export interface PushClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: PushClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PushMetadata {
  league: string | null;
  match: string | null;
  status: string | null;
  eventType: string | null;
  operation: string | null;
  version: string | null;
}

export type PushMessage =
  | { type: 'heartbeat'; interval: number | null }
  | { type: 'event'; game: Record<string, unknown> | null; event: Record<string, unknown> | null; metadata: PushMetadata }
  | { type: 'unrecognized' };

export type PushStreamEvent =
  | { type: 'connecting'; attempt: number; at: number }
  | { type: 'open'; attempt: number; at: number }
  | { type: 'message'; message: PushMessage; at: number }
  | { type: 'invalid-line'; error: string; at: number }
  | { type: 'disconnected'; reason: string; status: number | null; retryInMs: number; at: number }
  | { type: 'stopped'; at: number };

export type PushState = 'idle' | 'connecting' | 'open' | 'waiting' | 'stopped';

export interface PushStreamOptions {
  url: string;
  apiKey: ApiKey;
  fetch?: typeof fetch;
  clock?: PushClock;
  random?: () => number;
  /** Reconnect when nothing arrives for this long. Heartbeats come every 5 seconds. */
  silenceMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** A line longer than this ends the connection instead of growing memory. */
  maxLineChars?: number;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** Classify one parsed JSON line. */
export function parsePushMessage(value: unknown): PushMessage {
  const root = obj(value);
  if (!root) return { type: 'unrecognized' };
  const heartbeat = obj(root.heartbeat);
  if (heartbeat) {
    const interval = heartbeat.interval;
    return { type: 'heartbeat', interval: typeof interval === 'number' && Number.isFinite(interval) ? interval : null };
  }
  const payload = obj(root.payload);
  const meta = obj(root.metadata);
  if (!payload && !meta) return { type: 'unrecognized' };
  return {
    type: 'event',
    game: obj(payload?.game),
    event: obj(payload?.event),
    metadata: {
      league: text(meta?.league),
      match: text(meta?.match),
      status: text(meta?.status),
      eventType: text(meta?.event_type),
      operation: text(meta?.operation),
      version: text(meta?.version),
    },
  };
}

/** Splits a text stream into lines. Chunks may end anywhere, including inside a UTF-8 character. */
export class LineSplitter {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(private readonly maxLineChars = 4_000_000) {}

  /** Complete lines found so far. Throws when a line grows past the limit. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    if (this.buffer.length > this.maxLineChars) throw new Error(`A push line exceeded ${this.maxLineChars} characters`);
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  }

  /** Whatever remains when the stream ends. */
  flush(): string[] {
    const rest = (this.buffer + this.decoder.decode()).replace(/\r$/, '');
    this.buffer = '';
    return rest.trim() === '' ? [] : [rest];
  }
}

export class SportradarPushStream {
  private readonly listeners = new Set<(event: PushStreamEvent) => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly clock: PushClock;
  private readonly random: () => number;
  private readonly silenceMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxLineChars: number;
  private currentState: PushState = 'idle';
  private controller: AbortController | null = null;
  private retryTimer: unknown = null;
  private silenceTimer: unknown = null;
  private loop: Promise<void> | null = null;
  private attempts = 0;
  private failures = 0;
  private silent = false;

  constructor(private readonly options: PushStreamOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.silenceMs = options.silenceMs ?? 20_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.maxLineChars = options.maxLineChars ?? 4_000_000;
  }

  get state(): PushState {
    return this.currentState;
  }

  on(listener: (event: PushStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.currentState !== 'idle') return;
    this.connect();
  }

  /** Close the connection, cancel any pending reconnect and wait for the reader to finish. */
  async stop(): Promise<void> {
    if (this.currentState === 'stopped') return;
    this.currentState = 'stopped';
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearSilence();
    this.controller?.abort(new Error('stopped'));
    const loop = this.loop;
    if (loop) await loop;
    this.emit({ type: 'stopped', at: this.clock.now() });
  }

  /** Delay before reconnect attempt n (1-based): exponential, capped, with jitter in [half, full]. */
  backoffDelay(failures: number): number {
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.max(0, failures - 1));
    return Math.round(exp * (0.5 + this.random() * 0.5));
  }

  private emit(event: PushStreamEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A failing listener must not break the stream or other listeners.
      }
    }
  }

  private connect() {
    this.retryTimer = null;
    this.attempts++;
    this.currentState = 'connecting';
    this.emit({ type: 'connecting', attempt: this.attempts, at: this.clock.now() });
    this.loop = this.read(this.attempts);
  }

  private armSilence(controller: AbortController) {
    this.clearSilence();
    this.silenceTimer = this.clock.setTimeout(() => {
      this.silent = true;
      controller.abort(new Error('silence'));
    }, this.silenceMs);
  }

  private clearSilence() {
    if (this.silenceTimer !== null) this.clock.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private async read(attempt: number): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.silent = false;
    let status: number | null = null;
    let reason = 'The stream ended';
    let delivered = false;
    this.armSilence(controller);
    try {
      const res = await this.fetchImpl(this.options.url, {
        headers: { 'x-api-key': this.options.apiKey.reveal() },
        redirect: 'follow',
        signal: controller.signal,
      });
      status = res.status;
      if (!res.ok || !res.body) {
        void res.body?.cancel().catch(() => undefined);
        reason = res.ok ? 'The response had no body' : `HTTP ${res.status}`;
      } else {
        this.currentState = 'open';
        this.emit({ type: 'open', attempt, at: this.clock.now() });
        const splitter = new LineSplitter(this.maxLineChars);
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            this.armSilence(controller);
            for (const line of splitter.push(value)) if (this.handleLine(line)) delivered = true;
          }
          for (const line of splitter.flush()) if (this.handleLine(line)) delivered = true;
        } finally {
          void reader.cancel().catch(() => undefined);
        }
      }
    } catch (e) {
      reason = this.silent ? `No data for ${this.silenceMs}ms` : `Network error: ${(e as Error).message}`;
    } finally {
      this.clearSilence();
      if (this.controller === controller) this.controller = null;
    }
    if (this.currentState === 'stopped') return;
    // A connection that delivered a valid message was healthy, so back-off starts over.
    if (delivered) this.failures = 0;
    this.failures++;
    const retryInMs = this.backoffDelay(this.failures);
    this.currentState = 'waiting';
    this.emit({ type: 'disconnected', reason, status, retryInMs, at: this.clock.now() });
    this.retryTimer = this.clock.setTimeout(() => {
      if (this.currentState === 'waiting') this.connect();
    }, retryInMs);
  }

  /** True when the line was a valid heartbeat or event. */
  private handleLine(line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit({ type: 'invalid-line', error: 'A push line was not valid JSON', at: this.clock.now() });
      return false;
    }
    const message = parsePushMessage(parsed);
    this.emit({ type: 'message', message, at: this.clock.now() });
    return message.type !== 'unrecognized';
  }
}
