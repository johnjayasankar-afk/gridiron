/**
 * Gridiron's persistent server: one shared engine reading the provider for every
 * connected browser, server-sent updates, the replay lab, team pages, watch
 * parties, push alerts, Kalshi market prices and the built client.
 *
 *   npm run dev     development (with the Vite client)
 *   npm start       production, after npm run build
 */
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { GridironEngine } from './engine.js';
import { ProviderFetcher } from './fetcher.js';
import { createApp } from './http.js';
import { MarketService } from './markets/service.js';
import { PartyHub } from './party.js';
import { createPartyRoutes } from './partyRoutes.js';
import { EspnProvider } from './providers/espn/provider.js';
import { loadSportradarConfig } from './providers/sportradar/config.js';
import { SportradarProvider } from './providers/sportradar/provider.js';
import type { SportsProvider } from './providers/types.js';
import { setupPush } from './push/index.js';
import { ReplayLab } from './replay/lab.js';
import { TeamService } from './teams.js';
import { VERSION } from '../shared/version.js';

// server/index.ts in development and dist-server/index.mjs in production both sit one level below the root.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(process.env, ROOT);
const startedAt = Date.now();
const fetcher = new ProviderFetcher(config.fetch);
const lab = new ReplayLab({
  fixturesDir: resolve(ROOT, process.env.GRIDIRON_FIXTURES_DIR ?? 'fixtures/espn'),
  maxSessions: config.maxReplaySessions,
});

/** The licensed provider, from SPORTRADAR_* variables. A missing or invalid key stops the server with the reason; keys are never printed. */
function sportradarProvider(): SportsProvider {
  try {
    const settings = loadSportradarConfig(process.env);
    for (const warning of settings.warnings) console.warn(`[sportradar] ${warning}`);
    return new SportradarProvider(settings);
  } catch (e) {
    console.error(`Sportradar could not start: ${(e as Error).message}`);
    process.exit(1);
  }
}

// Kalshi prices from its public market data, shared by every viewer. Live data only; GRIDIRON_MARKETS=off turns them off.
const marketsOff = config.provider === 'replay' ? 'A replay server shows only the prices captured for its games' : process.env.GRIDIRON_MARKETS === 'off' ? 'Market prices are turned off on this server' : null;
const markets = marketsOff ? null : new MarketService({ fetcher: new ProviderFetcher({ ...config.fetch, maxConcurrent: 2, budgetPerMinute: 60, maxRetries: 1 }), log: (message) => console.warn(`[markets] ${message}`) });

let engine: GridironEngine;
if (config.provider === 'replay') {
  const created = lab.create(config.replayScenario, { persistent: true });
  if ('error' in created) {
    console.error(`Replay scenario "${config.replayScenario}" could not start: ${created.error}`);
    process.exit(1);
  }
  engine = lab.engine(created.id)!;
} else {
  const provider =
    config.provider === 'sportradar'
      ? sportradarProvider()
      : new EspnProvider(fetcher, { coverageCacheFile: config.cacheDir ? join(config.cacheDir, 'espn-coverage.json') : null });
  engine = new GridironEngine({
    provider,
    mode: 'live',
    intervals: config.intervals,
    log: (message) => console.warn(`[engine] ${message}`),
    marketHistory: markets ? (game) => markets.history(game) : undefined,
  });
  engine.start();
}

// Team pages read ESPN team documents, whose game ids match ESPN's; with another provider their links would not resolve.
const teams = config.provider === 'sportradar' ? null : new TeamService({ fetcher, savedDir: resolve(ROOT, process.env.GRIDIRON_TEAM_FIXTURES_DIR ?? 'fixtures/espn/team') });
const parties = new PartyHub();
parties.start();
const push = setupPush({ engine, env: process.env, cacheDir: config.cacheDir, production: config.production, trustProxy: config.trustProxy });
push.start();

markets?.start(engine);

const app = createApp({
  engine,
  replay: config.maxReplaySessions > 0 ? lab : null,
  staticDir: process.env.GRIDIRON_STATIC_DIR === 'none' ? null : config.staticDir,
  maxStreams: config.maxStreams,
  version: VERSION,
  fetcherStats: () => ({ ...fetcher.stats() }),
  startedAt,
  teams,
  routes: [createPartyRoutes({ hub: parties, trustProxy: config.trustProxy, maxStreams: config.maxStreams }), push.routes],
  health: () => ({
    party: { available: true, ...parties.stats() },
    teams: teams?.stats() ?? null,
    push: push.health(),
    markets: markets ? { available: true, ...markets.stats() } : { available: false, reason: marketsOff },
  }),
});

const server = createServer((req, res) => {
  void app(req, res);
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(config.port, config.host, () => {
  const mode = config.provider === 'replay' ? `replay lab (${config.replayScenario})` : config.provider === 'sportradar' ? 'licensed Sportradar data' : 'live ESPN data';
  console.log(`Gridiron server on http://${config.host}:${config.port} using ${mode}`);
});

let stopping = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  console.log(`Gridiron server stopping (${signal})`);
  // Whatever happens below, the process ends within a few seconds.
  setTimeout(() => process.exit(0), 5_000).unref();
  engine.stop();
  markets?.stop();
  lab.stopAll();
  parties.stop();
  void push.stop().finally(() => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    // Live event streams never end on their own, so they are closed after a moment for requests still finishing.
    setTimeout(() => server.closeAllConnections(), 1_000).unref();
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
