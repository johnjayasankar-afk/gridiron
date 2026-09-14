# Data providers

Gridiron separates the data source from everything else. The engine, the HTTP and stream layer, the alert engine and the whole client read only the normalized model in `shared/model.ts`. A provider turns a source's responses into that model, and nothing else.

## The interface

`server/providers/types.ts`:

```ts
interface SportsProvider {
  readonly info: ProviderInfo; // id, name, a plain description, licensed, push, divisions
  fetchSlate(league: LeagueId, dateKey: string, options: SlateOptions): Promise<SlateResult>;
  fetchDetail(gameId: GameId, knownDivisions?: Division[]): Promise<DetailResult>;
  subscribe?(onEvent: (event: ProviderPushEvent) => void): () => void; // optional push
}
```

- `fetchSlate` returns every game for a league on a provider day (`YYYYMMDD`, US Eastern). It also returns per-division coverage and health, partial errors, and a plain statement of how coverage was discovered and what is limited. Set `failed: true` only when nothing could be read.
- `fetchDetail` returns the full `GameDetail`: summary, drives, ordered plays, scoring, team stats, history gaps and, when reported, win probability after each play. It can also return a failure with the reason.
- `subscribe`, when present, pushes normalized updates. The engine still calls `fetchSlate` and `fetchDetail` on its usual schedule, which reconciles anything a push missed.

Sportsbook lines (`GameSummary.lines`), the latest win probability (`GameSummary.winProbability`) and a pre-game prediction (`GameSummary.predictor`) are optional. A provider that does not report them leaves them out.

## Rules every provider must follow

1. **Unknown is null.** A value the source did not report is `null`, never `0`, `false` or a guess. Ball spots that cannot be placed use `UNKNOWN_SPOT`, and the UI says "Ball spot unavailable". A lateral position is `null` unless the source reports a validated one.
2. **Ids are namespaced.** Use `gameId(league, providerEventId)`, `teamKey(league, providerTeamId)` and `${gameId}:${providerPlayId}` for plays.
3. **Classify from explicit data.** Play kinds come from the source's play types and flags, never from score arithmetic.
4. **Fail visibly.** On an error, return the failure with a message. Never fall back to other data, cached fiction or a different source without saying so.
5. **Spots carry provenance.** Record where each `BallSpot` came from (`label`, `home-yardline`, `yards-to-endzone`) and whether it is `pre-snap` or `post-play`.
6. **Keys stay on the server.** Credentials come from environment variables read in `server/`. They are never part of a response, never logged and never shipped to the client bundle.
7. **Chances are reported, never computed.** Win probability and predictions are passed through exactly as the source's model reports them.
8. **Test against captured responses.** Add fixtures under `fixtures/<provider>/` and normalization tests under `tests/`, as the ESPN provider does.

## Choosing a provider

`GRIDIRON_PROVIDER` selects the source in `server/index.ts`:

| Value | Source |
| --- | --- |
| `espn` (default) | ESPN's public site API, polled |
| `sportradar` | Sportradar's licensed NFL and NCAA Football v7 APIs, with keys from the environment |
| `replay` | A captured replay lab scenario as the main data, for demos and tests |

For `sportradar`, the server reads its settings with `loadSportradarConfig(process.env)` and starts `new SportradarProvider(settings)`. Configuration warnings, such as push requested on trial access, are logged at start. A missing or malformed key stops the server at start with the name of the variable to check. Key values are never printed.

## Push providers

When a provider implements `subscribe`, the engine subscribes when it starts and unsubscribes when it stops.

- A pushed summary merges into the slate exactly like a polled one, and clients receive the same slate delta.
- A pushed detail is kept only for games someone follows. It is fingerprinted and versioned like a poll, so clients cannot tell the two apart. For other games, a push updates the slate summary only.
- A poll that returns data received before the latest push is ignored, so a slower poll cannot undo a newer push.
- Polling continues underneath at the usual intervals and reconciles anything the stream missed, including after a reconnect.

## Prediction markets

Market prices are not part of a provider. `server/markets/` reads them beside the provider, and the engine attaches them to each game's summary (`GameSummary.market`). They travel through the same slate deltas and the same spoiler delay as everything else.

The one exchange implemented is **Kalshi**, whose public market data needs no account or key. It was read successfully during the build on 14 September 2026.

- **Contracts.** Game contracts are listed per league (series `KXNFLGAME` and `KXNCAAFGAME`), at most every 10 minutes. A game matches an event only when the event ticker carries the game's US Eastern date and both teams' codes, and the event has a contract for each team. NFL codes equal ESPN's abbreviations except JAC (ESPN: JAX) and WAS (ESPN: WSH). College games match only where Kalshi's codes equal ESPN's. Nothing is matched by team name.
- **Spread and total.** When the sportsbook reports lines, the spread and total ladders (`KXNFLSPREAD`, `KXNFLTOTAL`, `KXNCAAFSPREAD`, `KXNCAAFTOTAL`) are read, and the contracts nearest the sportsbook's spread and total are used, if within 3 points.
- **Prices.** The chosen contracts are read in batches of 20. The price shown is the midpoint of the best bid and ask while they are at most 5 cents apart, otherwise the last trade. A contract with neither has no price.
- **Refresh.** Every 15 seconds while any game Gridiron follows is live or within an hour of kickoff, otherwise every 5 minutes. Only games that are live, or scheduled to start within three days, are read, and a game that ends loses its prices.
- **Failure.** Prices from the last successful read stay, marked stale after 90 seconds, and are dropped after 10 minutes.
- **History.** For a game someone follows, the home team's contract across time, from Kalshi's candlesticks: hourly over the week before kickoff and minute by minute from an hour before it. Each period is priced by the same rule as a quote, and a period with neither a close quote nor a trade is left out. It is read every 45 seconds while the game is live and every 5 minutes before, and travels on the game's detail (`GameDetail.marketHistory`), so it follows the spoiler delay. A finished game keeps the history it had.
- **Deployments.** The persistent server runs the reader on a schedule. The Vercel entry reads prices when a slate is requested, and a game's history when its detail is requested, waiting at most 3 seconds each. `GRIDIRON_MARKETS=off` turns markets off.
- **Replays** never read Kalshi. Real replays carry prices captured earlier with `npx tsx scripts/capture-kalshi.ts` (`fixtures/kalshi/<league>-<date>.json`: each team's contract, minute by minute, from an hour before kickoff to the end of the game). The replay lab cuts them at its clock, like the plays, and synthetic scenarios never receive them. The NFL Week 1 replay's 13 games were captured on 14 September 2026.

Another exchange can be added by returning the same `MarketPrices` for each game from a reader with `read(games)`, which is all the engine's serverless path uses, and a `MarketHistory` from `history(game)`.

## The Sportradar adapter

`server/providers/sportradar/` implements `SportsProvider` for the NFL and NCAA Football v7 APIs. It was written from Sportradar's public documentation. **It has never been run against the real API**: its tests use fictional fixtures (`fixtures/sportradar/`) and a local stream server. Verify it against your licence and live responses before relying on it.

Configuration:

| Variable | Meaning |
| --- | --- |
| `SPORTRADAR_NFL_API_KEY` | NFL key. At least one of the two keys is required |
| `SPORTRADAR_NCAAFB_API_KEY` | NCAA Football key |
| `SPORTRADAR_ACCESS_LEVEL` | `trial` (default) or `production`; chooses the API path |
| `SPORTRADAR_PUSH` | `on` streams push events. Push feeds exist on production access only; on trial the setting is ignored with a warning |

How it works:

- **Requests.** Keys are sent only in the `x-api-key` header. Request starts are spaced per key at one per second, the trial limit, on either access level. After a 429 the key backs off, doubling with each consecutive 429 up to 5 minutes, or for as long as `Retry-After` asks.
- **Slate.** The league's current season schedule is read and reused for 6 hours, and the games whose US Eastern date matches the requested day are kept. Games that are live, final or past their kickoff are read from their boxscores; the rest come from the schedule.
- **Detail.** The game's play-by-play. Each play's start and end situations become its pre-snap and post-play spots. While the game is live, the document's situation block becomes the live situation.
- **Push.** On production access with `SPORTRADAR_PUSH=on`, each streamed event updates that game's summary at once. About 3 seconds after a play arrives, once per burst, the play-by-play is read again and sent as detail. The stream has no resume, so after a reconnect the play-by-play of every game that was live is read again. The stream reconnects after 20 seconds of silence or any error, with capped back-off.
- **Ids.** Game and team ids carry the provider's UUIDs with hyphens written as underscores, for example `nfl-sr:1a2b3c4d_…`.
- **Partial failures.** A game whose boxscore cannot be read is left out of the slate and its league is marked unavailable, so the engine keeps the games it already has and marks them stale.

Known limits, from the documented fields:

- Pass outcomes (completions, incompletions, sacks, interceptions) are not separable from the documented detail categories, so a non-scoring pass is `other`. Play `turnover` and yardage are always null.
- Always null or empty: drive start and end spots, drive descriptions, colors, logos, ranks, records, conferences, venues, broadcasts, team stats, leaders, attendance, lines, win probability and lateral position. NFL plays carry `hash_mark`, but its frame of reference is undocumented, so it is not used.
- College divisions are not named in the documented fields, so college games carry no division.
- Team pages read ESPN team documents, so they are turned off when Sportradar is the provider. Kalshi prices still match by team codes and dates.

## The ESPN provider, for reference

`server/providers/espn/` shows each part of the pattern:

- `raw.ts`: defensive readers for untrusted JSON, and URL checks for images and links.
- `classify.ts`: play type and conversion classification from the reported text.
- `coverage.ts`: college division discovery from the provider's own group metadata.
- `normalize.ts`: scoreboard and summary normalization, spot resolution with provenance, and play ordering and deduplication. It also handles the captured quirks: 0-0 stoppages, leftover clocks, and the current drive repeated among previous drives.
- `odds.ts`: sportsbook lines from the scoreboard's `odds` and the summary's `pickcenter` (first-priority book, opening and latest values, checked against the game's teams), win probability after each play from `winprobability` and from a scoreboard's last play, and the pre-game `predictor`.
- `provider.ts`: slate assembly across divisions, partial failures, conference names and the detail fetch.
- `team.ts`: team documents and season schedules for team pages. Bye weeks come from gaps in the reported week numbers, because the documents' own bye week field was found to be unreliable.
