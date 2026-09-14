/**
 * Serverless entry point (Vercel). A serverless function cannot hold a stream
 * open or poll in the background, so this deployment is deliberately bounded:
 *
 * - Every /api/... request reaches this one function through a rewrite in
 *   vercel.json that carries the original path in the __path query parameter,
 *   because Vercel does not route nested paths to a catch-all file outside
 *   Next.js. The original URL is restored before routing (server/vercelRouting.ts).
 * - The client polls: /api/health reports transport "poll", and /api/stream and
 *   /api/interest are not offered.
 * - Nothing polls between requests. The engine is never started, so each request
 *   fetches only what it needs through the same provider, normalization and
 *   engine code as the persistent server, within the fetcher's time budget.
 * - Kalshi prices are read when a slate is requested, and a game's Kalshi price
 *   history when its detail is, each with at most 3 seconds' wait, and kept briefly
 *   by the warm function. GRIDIRON_MARKETS=off turns them off.
 * - Slate, game and team responses carry short CDN lifetimes (s-maxage 10s, 8s
 *   and 60s), so concurrent viewers share one provider request instead of each making one.
 * - The replay lab, watch parties and push alerts are not offered, because they
 *   need a long-lived process. Their routes and /api/health say so.
 *
 * The persistent Node server (npm run build && npm start) is the full deployment.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GridironEngine } from '../server/engine.js';
import { DEFAULT_FETCH_POLICY, ProviderFetcher } from '../server/fetcher.js';
import { createApp } from '../server/http.js';
import { MarketService } from '../server/markets/service.js';
import { createPartyRoutes } from '../server/partyRoutes.js';
import { EspnProvider } from '../server/providers/espn/provider.js';
import { unavailablePush } from '../server/push/index.js';
import { TeamService } from '../server/teams.js';
import { originalApiUrl } from '../server/vercelRouting.js';
import { VERSION } from '../shared/version.js';

const LONG_LIVED = 'need the persistent Gridiron server';

let app: ReturnType<typeof createApp> | null = null;

function instance(): ReturnType<typeof createApp> {
  if (app) return app;
  const fetcher = new ProviderFetcher();
  const provider = new EspnProvider(fetcher, { coverageCacheFile: null });
  const markets = process.env.GRIDIRON_MARKETS === 'off' ? null : new MarketService({ fetcher: new ProviderFetcher({ ...DEFAULT_FETCH_POLICY, timeoutMs: 2_500, maxConcurrent: 2, budgetPerMinute: 60, maxRetries: 0 }) });
  const engine = new GridironEngine({ provider, mode: 'live', ...(markets ? { markets } : {}), marketHistory: markets ? (game) => markets.history(game) : undefined });
  const partyReason = `Watch parties ${LONG_LIVED}`;
  const push = unavailablePush(`Push alerts ${LONG_LIVED}`);
  app = createApp({
    engine,
    replay: null,
    staticDir: null,
    maxStreams: 0,
    version: process.env.GRIDIRON_VERSION ?? VERSION,
    fetcherStats: () => ({ ...fetcher.stats() }),
    startedAt: Date.now(),
    transport: 'poll',
    teams: new TeamService({ fetcher }),
    routes: [createPartyRoutes({ hub: null, reason: partyReason }), push.routes],
    health: () => ({
      party: { available: false, reason: partyReason },
      push: push.health(),
      markets: markets ? { available: true, ...markets.stats() } : { available: false, reason: 'Market prices are turned off on this deployment' },
    }),
  });
  return app;
}

export default async function gridiron(req: IncomingMessage, res: ServerResponse): Promise<void> {
  req.url = originalApiUrl(req.url);
  await instance()(req, res);
}
