/**
 * The replay lab: labelled replays of captured games and synthetic test
 * scenarios, each running in its own session with its own virtual clock and
 * engine. Sessions share nothing with the live engine.
 */
import { randomUUID } from 'node:crypto';
import type { Division, DivisionCoverage, GameSummary, LeagueId } from '../../shared/model.js';
import { GridironEngine, type PollIntervals } from '../engine.js';
import type { ReplayCommand, ReplayHub, ReplaySessionInfo } from '../http.js';
import { newDiagnostics, normalizeScoreboardEvent, normalizeSummary } from '../providers/espn/normalize.js';
import type { DetailResult, ProviderInfo, SlateOptions, SlateResult, SportsProvider } from '../providers/types.js';
import { detailWithLateral, lateralsFor, summaryWithLateral } from './lateral.js';
import { FixtureStore, SCENARIOS, withCapturedMarket, type BuiltScenario, type ScenarioDef } from './scenarios.js';
import { marketAt, marketHistoryAt, scoreboardEventAt, summaryAt, visiblePlays, type GameTimeline } from './timeline.js';

export const REPLAY_INTERVALS: Partial<PollIntervals> = {
  slateLive: 2_000,
  slateIdle: 4_000,
  slatePast: 4_000,
  detailFocus: 2_000,
  detailVisible: 3_000,
  detailBackground: 4_000,
  detailScheduled: 6_000,
  detailFinal: 30_000,
};

const iso = (ms: number) => new Date(ms).toISOString();

export class VirtualClock {
  private anchorReal: number;
  private anchorVirtual: number;
  private playing: boolean;
  private forcedOutageUntil = 0;
  speed: number;

  constructor(
    readonly start: number,
    readonly end: number,
    speed: number,
    private readonly realNow: () => number = Date.now,
    playing = true,
  ) {
    this.anchorReal = realNow();
    this.anchorVirtual = start;
    this.speed = speed;
    this.playing = playing;
  }

  now(): number {
    if (!this.playing) return this.anchorVirtual;
    return Math.min(this.end, this.anchorVirtual + (this.realNow() - this.anchorReal) * this.speed);
  }

  private rebase() {
    this.anchorVirtual = this.now();
    this.anchorReal = this.realNow();
  }

  play() {
    this.rebase();
    this.playing = true;
  }
  pause() {
    this.rebase();
    this.playing = false;
  }
  setSpeed(speed: number) {
    this.rebase();
    this.speed = Math.min(600, Math.max(1, speed));
  }
  step(seconds: number) {
    this.rebase();
    this.anchorVirtual = Math.min(this.end, Math.max(this.start, this.anchorVirtual + seconds * 1000));
  }
  seek(progress: number) {
    this.rebase();
    this.anchorVirtual = this.start + Math.min(1, Math.max(0, progress)) * (this.end - this.start);
  }
  outage(seconds: number) {
    this.forcedOutageUntil = this.realNow() + Math.min(600, Math.max(0, seconds)) * 1000;
  }
  inForcedOutage() {
    return this.realNow() < this.forcedOutageUntil;
  }
  status() {
    const v = this.now();
    return {
      playing: this.playing,
      speed: this.speed,
      virtualTime: iso(v),
      progress: this.end > this.start ? (v - this.start) / (this.end - this.start) : 1,
      start: iso(this.start),
      end: iso(this.end),
      outage: this.inForcedOutage(),
    };
  }
}

/** The provider id of the latest play a timeline shows at a moment. */
function latestPlayId(tl: GameTimeline, tv: number): string | null {
  const visible = visiblePlays(tl, tv);
  return visible.length ? String(visible[visible.length - 1].raw.id) : null;
}

export class ReplayProvider implements SportsProvider {
  readonly info: ProviderInfo;
  readonly diagnostics = newDiagnostics();

  constructor(
    private readonly scenario: BuiltScenario,
    private readonly clock: VirtualClock,
    def: ScenarioDef,
  ) {
    this.info = {
      id: 'replay',
      name: 'Replay lab',
      description: def.synthetic
        ? 'Synthetic test scenario built on captured ESPN data. These are not real events.'
        : 'Captured ESPN play-by-play replayed on a virtual clock. Not live.',
      licensed: false,
      push: false,
      divisions: ['NFL', 'FBS', 'FCS', 'D2', 'D3'],
    };
  }

  private failing(): boolean {
    const tv = this.clock.now();
    return this.clock.inForcedOutage() || this.scenario.outages.some((o) => tv >= o.from && tv < o.until);
  }

  async fetchSlate(league: LeagueId, dateKey: string, options: SlateOptions): Promise<SlateResult> {
    const receivedAt = Date.now();
    const scope = league === 'nfl' ? 'NFL scoreboard' : 'College scoreboard';
    if (this.failing()) {
      return { league, dateKey, games: [], divisions: [], errors: [{ scope, message: 'Replay test scenario: the provider is not responding', status: 503 }], failed: true, receivedAt, discovery: '', limitations: [] };
    }
    const tv = this.clock.now();
    const wanted = (divisions: Division[]) => league === 'nfl' || divisions.some((d) => options.divisions.includes(d));
    const inPlay = dateKey === this.scenario.date ? this.scenario.games.filter((g) => g.league === league && wanted(g.divisions)) : [];
    const games = inPlay
      .map((g) => {
        const summary = normalizeScoreboardEvent(scoreboardEventAt(g, tv), league, league === 'nfl' ? ['NFL'] : g.divisions.filter((d) => options.divisions.includes(d)), this.diagnostics);
        // Only the lateral position test scenario decorates its summaries.
        const laterals = summary ? lateralsFor(g) : null;
        const decorated = summary && laterals ? summaryWithLateral(summary, laterals, latestPlayId(g, tv)) : summary;
        // Captured exchange prices, as a live reader would have shown them at this moment.
        return decorated && g.market ? { ...decorated, market: marketAt(g, tv) } : decorated;
      })
      .filter((g): g is GameSummary => g !== null);
    const divisions: DivisionCoverage[] =
      league === 'nfl'
        ? [{ division: 'NFL', label: 'NFL', providerGroupId: null, games: games.length, health: 'connected' }]
        : options.divisions.map((d) => ({ division: d, label: d, providerGroupId: null, games: games.filter((g) => g.divisions.includes(d)).length, health: 'connected' as const }));
    return { league, dateKey, games, divisions, errors: [], failed: false, receivedAt, discovery: 'Replay lab: captured games only.', limitations: this.scenario.limitations };
  }

  async fetchDetail(id: string): Promise<DetailResult> {
    const receivedAt = Date.now();
    if (this.failing()) return { ok: false, error: { scope: 'Game detail', message: 'Replay test scenario: the provider is not responding', status: 503 }, receivedAt };
    const tl = this.scenario.games.find((g) => g.id === id);
    if (!tl) return { ok: false, error: { scope: 'Game detail', message: 'This game is not part of the replay', status: 404 }, receivedAt };
    const tv = this.clock.now();
    const detail = normalizeSummary(summaryAt(tl, tv), tl.league, tl.divisions, this.diagnostics);
    if (!detail) return { ok: false, error: { scope: 'Game detail', message: 'Replay summary could not be read', status: null }, receivedAt };
    const laterals = lateralsFor(tl);
    const decorated = laterals ? detailWithLateral(detail, laterals) : detail;
    if (!tl.market) return { ok: true, detail: decorated, receivedAt };
    return { ok: true, detail: { ...decorated, summary: { ...decorated.summary, market: marketAt(tl, tv) }, marketHistory: marketHistoryAt(tl, tv) }, receivedAt };
  }
}

interface Session {
  id: string;
  def: ScenarioDef;
  built: BuiltScenario;
  clock: VirtualClock;
  engine: GridironEngine;
  lastUsed: number;
  persistent: boolean;
}

export class ReplayLab implements ReplayHub {
  private readonly fixtures: FixtureStore;
  private readonly sessions = new Map<string, Session>();
  private readonly built = new Map<string, BuiltScenario | null>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly options: { fixturesDir: string; maxSessions: number; idleMs?: number }) {
    this.fixtures = new FixtureStore(options.fixturesDir);
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  private build(def: ScenarioDef): BuiltScenario | null {
    if (!this.built.has(def.id)) {
      let result: BuiltScenario | null = null;
      try {
        result = def.build(this.fixtures);
      } catch {
        result = null;
      }
      this.built.set(def.id, result);
    }
    return this.built.get(def.id) ?? null;
  }

  scenarios() {
    return SCENARIOS.flatMap((def) => {
      const built = this.build(def);
      return built ? [{ id: def.id, label: def.label, description: def.description, synthetic: def.synthetic, date: built.date }] : [];
    });
  }

  create(scenarioId: string, opts: { persistent?: boolean; playing?: boolean; speed?: number; progress?: number } = {}): ReplaySessionInfo | { error: string } {
    const def = SCENARIOS.find((s) => s.id === scenarioId);
    if (!def) return { error: 'Unknown replay scenario' };
    // Timelines carry per-session edits; build a fresh copy for each session.
    let built: BuiltScenario | null;
    try {
      built = def.build(this.fixtures);
    } catch {
      built = null;
    }
    if (!built) return { error: 'This scenario’s captured data is not installed' };
    // Real replays carry the exchange prices captured for their games. Synthetic scenarios never do, since their edits did not happen.
    if (!def.synthetic) for (const tl of built.games) withCapturedMarket(this.fixtures, tl);
    this.sweep();
    const transient = [...this.sessions.values()].filter((s) => !s.persistent).length;
    if (!opts.persistent && transient >= this.options.maxSessions) return { error: 'Too many replay sessions are running; try again shortly' };
    const clock = new VirtualClock(built.startAt, built.endAt, opts.speed ?? def.speed, Date.now, opts.playing ?? true);
    if (opts.progress !== undefined) clock.seek(opts.progress);
    const provider = new ReplayProvider(built, clock, def);
    const scenarioDate = built.date;
    const engine = new GridironEngine({ provider, mode: 'replay', replayLabel: def.label, today: () => scenarioDate, intervals: REPLAY_INTERVALS, random: () => 0.5 });
    engine.start();
    const id = randomUUID();
    this.sessions.set(id, { id, def, built, clock, engine, lastUsed: Date.now(), persistent: opts.persistent === true });
    return { id, scenario: def.id, label: def.label };
  }

  engine(id: string): GridironEngine | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.lastUsed = Date.now();
    return s.engine;
  }

  control(id: string, command: ReplayCommand): Record<string, unknown> | { error: string } {
    const s = this.sessions.get(id);
    if (!s) return { error: 'Unknown or expired replay session' };
    s.lastUsed = Date.now();
    switch (command.type) {
      case 'play':
        s.clock.play();
        break;
      case 'pause':
        s.clock.pause();
        break;
      case 'speed':
        if (typeof command.speed !== 'number') return { error: 'speed must be a number' };
        s.clock.setSpeed(command.speed);
        break;
      case 'step':
        if (typeof command.seconds !== 'number') return { error: 'seconds must be a number' };
        s.clock.step(command.seconds);
        break;
      case 'seek':
        if (typeof command.progress !== 'number') return { error: 'progress must be a number' };
        s.clock.seek(command.progress);
        break;
      case 'outage':
        s.clock.outage(typeof command.seconds === 'number' ? command.seconds : 60);
        break;
      default:
        return { error: 'Unknown command' };
    }
    void s.engine.refreshAll();
    return this.status(id)!;
  }

  status(id: string): Record<string, unknown> | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { id, scenario: s.def.id, label: s.def.label, description: s.def.description, synthetic: s.def.synthetic, date: s.built.date, limitations: s.built.limitations, ...s.clock.status() };
  }

  private sweep() {
    const idle = this.options.idleMs ?? 15 * 60_000;
    for (const [id, s] of this.sessions) {
      if (!s.persistent && Date.now() - s.lastUsed > idle) {
        s.engine.stop();
        this.sessions.delete(id);
      }
    }
  }

  stopAll() {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) s.engine.stop();
    this.sessions.clear();
  }
}
