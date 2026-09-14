/**
 * Smoke test against a running Gridiron server.
 *
 *   npm run smoke                               checks http://127.0.0.1:8787
 *   GRIDIRON_URL=https://example.app npm run smoke
 *
 * It reports what it saw and exits non-zero when a required check fails.
 * "No live games right now" is reported, never treated as a failure.
 */
import type { GameDetail, GameSummary, SlateSnapshot } from '../shared/model';
import { isLiveOrPaused } from '../shared/model';

const BASE = (process.env.GRIDIRON_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

interface Health {
  ok: boolean;
  mode: string;
  transport: 'sse' | 'poll';
  today: string;
  replayAvailable: boolean;
  provider?: { name?: string };
}

let failures = 0;
function record(name: string, ok: boolean, detail: string, required = true) {
  if (!ok && required) failures++;
  console.log(`${ok ? 'ok  ' : required ? 'FAIL' : 'warn'}  ${name}: ${detail}`);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => json<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function firstEvent(path: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
    if (!res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const match = /event: ([\w-]+)/.exec(buffer);
      if (match) {
        controller.abort();
        return match[1];
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function describeSlate(slate: SlateSnapshot): string {
  const live = slate.games.filter((g) => isLiveOrPaused(g.status.kind)).length;
  return `${slate.games.length} games on ${slate.date}, ${live} live; NFL feed ${slate.freshness.nfl.health}, college feed ${slate.freshness.cfb.health}`;
}

async function main() {
  console.log(`Gridiron smoke test against ${BASE}\n`);
  const health = await json<Health>('/api/health');
  record('health', health.ok === true, `mode ${health.mode}, transport ${health.transport}, provider day ${health.today}, provider ${health.provider?.name ?? 'unknown'}`);

  const slate = await json<SlateSnapshot>('/api/slate');
  record('slate', Array.isArray(slate.games), describeSlate(slate));
  for (const d of slate.coverage.divisions) record(`coverage ${d.label}`, d.health !== 'unavailable', `${d.games} games, ${d.health}`, false);
  if (slate.coverage.conferences.length) record('conference names', true, `${slate.coverage.conferences.length} named`, false);

  const sample: GameSummary | undefined = slate.games.find((g) => isLiveOrPaused(g.status.kind)) ?? slate.games.find((g) => g.status.kind === 'final') ?? slate.games[0];
  if (sample) {
    const detail = await json<{ detail: GameDetail | null; freshness: { health: string; error: string | null } }>(`/api/game/${encodeURIComponent(sample.id)}`);
    const d = detail.detail;
    record('game detail', d !== null || sample.status.kind === 'scheduled', `${sample.shortName} (${sample.status.kind}): ${d ? `${d.plays.length} plays, ${d.drives.length} drives, ${d.scoring.length} scores` : `no detail yet (${detail.freshness.error ?? detail.freshness.health})`}`);
  } else record('game detail', true, 'skipped, no games on the provider day', false);

  if (health.transport === 'sse') {
    const event = await firstEvent('/api/stream');
    record('stream', event !== null, event ? `first event "${event}"` : 'no event within 8 seconds');
  } else record('stream', true, 'polled deployment, stream not offered', false);

  if (health.replayAvailable) {
    const { scenarios } = await json<{ scenarios: Array<{ id: string; synthetic: boolean }> }>('/api/replay/scenarios');
    record('replay scenarios', scenarios.length > 0, scenarios.map((s) => s.id).join(', '));
    const captured = scenarios.find((s) => !s.synthetic) ?? scenarios[0];
    if (captured) {
      const session = await post<{ id: string }>('/api/replay/sessions', { scenario: captured.id });
      await post(`/api/replay/s/${session.id}/control`, { type: 'seek', progress: 0.4 });
      const replay = await json<SlateSnapshot>(`/api/replay/s/${session.id}/slate`);
      const inProgress = replay.games.filter((g) => g.status.kind === 'in_progress');
      const spotted = inProgress.filter((g) => g.situation?.spot.schematicYard !== null && g.situation?.spot.schematicYard !== undefined);
      record('replay slate', replay.mode === 'replay' && replay.games.length > 0, `${captured.id}: ${replay.games.length} games, ${inProgress.length} in progress at 40%, ${spotted.length} with a reported ball spot`);
    }
  } else record('replay lab', true, 'not offered by this deployment', false);

  console.log(failures ? `\n${failures} required ${failures === 1 ? 'check' : 'checks'} failed.` : '\nAll required checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((e: Error) => {
  console.error(`FAIL  smoke: ${e.message}`);
  process.exit(1);
});
