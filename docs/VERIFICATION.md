# Verification report

Six builds are recorded here: **0.5.1** first, then **0.5**, **0.4**, **0.3**, **0.2** and the original **0.1** report.

## Version 0.5.1

Recorded Monday 14 September 2026, in the evening US Eastern. It covers a routing fault found on the live 0.5 deployment, and wording on the game page for games that have not started.

### The fault on Vercel

- On the deployed 0.5 site, built by Vercel from the project's GitHub repository, finished games showed no play-by-play, drives, scoring or team stats. Live games would have shown the same.
- Requests to the live site showed why. `/api/health` and `/api/slate?date=20260913` answered 200 from the function, but `/api/game/nfl-401872926`, `/api/team/nfl-12` and `/api/push/key` answered 404 with `x-vercel-error: NOT_FOUND`, Vercel's own "The page could not be found". The function was never called for them.
- Outside Next.js, Vercel matched `api/[...path].ts` as a single path segment, not as a catch-all. The earlier checks served the function from a plain Node server that sent every path to it, so they could not show this.
- ESPN had the complete data throughout. Its summaries for ARI at LAC (13 September 2026), NYG at DAL (14 September 2025) and a college game from 12 September 2026 each carried every drive, play, scoring play and team stat.

### The fix

- The function is now `api/index.ts`, and the first rewrite in `vercel.json` sends `/api/:path*` to `/api?__path=:path*`. Vercel checks files before applying rewrites, and rewrites keep the request's own query string, as Vercel's documentation and guides describe. The function restores the original path before routing (`server/vercelRouting.ts`).
- There is still one function, so every route keeps the same limits and warm instance.

### Checks

| Check | Result |
| --- | --- |
| Typecheck (`tsc`, strict) | Clean |
| Unit and integration tests (`npm test`) | **446 passed** in 51 files, including new tests for restoring the carried path, the rewrite in `vercel.json`, and the wording before kickoff |
| End-to-end journeys, production build, replay mode | **67 passed**: 60 in Chrome and 7 in WebKit |
| `npm run check:serverless -- --live` | Nested routes reached their handlers, both directly and in the form the rewrite delivers. The latest finished game, TB at CIN on 13 September 2026, came back with 177 plays, 18 drives, 12 scores and 15 team stats, requested with its date in the query |
| The polled client against the function, with the rewrite applied by a local server | BUF at HOU on 13 September showed 188 plays with its drives, scoring and team stats. The Arizona team page loaded, and ARI at LAC opened from it showed 184 plays |
| A game a week before kickoff (SEA at ARI) | "No plays reported yet", and no score-only wording anywhere on the page |

Screenshots and performance were not recorded again, since nothing they cover changed.

### Not verified for 0.5.1

- **Vercel itself.** The fix has not been deployed yet. Once it is, `/api/game/nfl-401872926` on the site should answer with the game's JSON instead of Vercel's 404.
- The rewrite was applied by a local server written to follow the `vercel.json` rule, not by Vercel.

## Version 0.5

Recorded Monday 14 September 2026, in the late afternoon US Eastern, on the same machine and with the same tools as 0.3 and 0.4. It covers the Vercel function, Kalshi price history, the replay lab's captured prices, the game page layout and the lighter start.

### Summary

| Check | Result |
| --- | --- |
| Typecheck (`tsc`, strict) | Clean |
| Unit and integration tests (`npm test`) | **443 passed** in 50 files (0.4: 430 in 46) |
| End-to-end journeys in Chrome, production build, replay mode | **60 passed**, including the accessibility audit |
| `@cross` journeys in WebKit | **7 passed** |
| `@cross` journeys in Firefox | **Not run.** Firefox still does not start on this machine (see Version 0.3) |
| Accessibility audit (axe-core, WCAG 2.1 A and AA) | No serious or critical violations on the 6 audited screens |
| Design screenshots (`GRIDIRON_CAPTURE=1`) | All 11 capture runs passed; 33 images in `docs/screenshots` |
| Performance recording (`GRIDIRON_PERF=1`) | 2 runs passed |
| The serverless function loaded the way Vercel loads it (`npm run check:serverless -- --live`) | 60 files loaded as plain Node ES modules. Health, stream and watch party routes answered as expected; today's slate carried Kalshi prices, and DEN at KC's detail carried 18 prices of history |
| The same check on the 0.4 code | **Failed to load:** "Cannot find module '…/server/engine'" |

After that full run, the only code change was the wording of when a price trend starts (fix 6 below). Typecheck, the unit tests, the odds journeys in Chrome and WebKit and the odds screenshots were run again after it: typecheck clean, 443 tests passed, all 5 odds journeys passed (4 in Chrome, 1 in WebKit), and the odds screenshots were captured again.

The 13 new unit tests cover:

- Kalshi candlesticks, and the price rule for each recorded period
- placing prices on the win probability chart, and the cut at the latest play shown
- price history in detail deltas
- the market reader's history reads and their reuse, and the engine attaching history as a new detail version
- captured prices in the replay lab: attached by date and teams, cut at the replay clock, and absent from synthetic scenarios
- every server import naming its file, and the version matching `package.json` and the service worker

Two journeys changed: the game page journey now checks the captured Kalshi table and trend, and the game flow journey checks the Kalshi line.

### The Vercel function

This is the most important finding of 0.5.

- Vercel loads `api/` functions in a `type: module` package as Node ES modules, transpiling each file on its own, and Node resolves only explicit relative paths. That is how Vercel's documentation and community describe it; it was not tried on Vercel itself.
- In 0.4, `api/[...path].ts` and the server code imported modules without extensions (`'../server/engine'`) and imported `package.json` as JSON. The 0.4 verification ran the entry through tsx, which resolves both, so nothing showed.
- `scripts/check-serverless.mjs` transpiles every file under `api/`, `server/` and `shared/` separately with esbuild and loads the function with plain Node. Run on the 0.4 code, exported from the Git index, it failed immediately: "Cannot find module '…/server/engine' imported from …/api/[...path].js". A 0.4 deployment would most likely have failed on every API request.
- 0.5 names the `.js` file in all 196 relative imports under `api/`, `server/` and `shared/`, reads the version from `shared/version.ts`, and adds a unit test that fails on any extensionless import. The check then passed offline and against the live feed, and CI now runs it.

### Bundle

| Chunk | Size | Brotli | gzip | Loads |
| --- | --- | --- | --- | --- |
| App (`index-*.js`) | 339.4 kB | 92.1 kB | 107.1 kB | At startup |
| Shared startup chunks (`jsx-runtime`, `ui`, `navigation`, `selectors`, `TeamLogo`, `theme`, `x`) | 68.4 kB | 23.9 kB | 26.4 kB | At startup, preloaded |
| Styles (`index-*.css`) | 111.1 kB | 19.6 kB | 22.9 kB | At startup |
| Game page (`DetailView-*.js`) | 63.7 kB | 16.7 kB | 18.6 kB | On first use, fetched when the page is idle |
| Settings dialogs (`dialogs-*.js`, `OddsSettings-*.js`) | 29.4 kB | 8.3 kB | 9.7 kB | On first use, fetched when the page is idle |
| Command palette (`CommandPalette-*.js`) | 8.5 kB | 2.8 kB | 3.3 kB | On first use, fetched when the page is idle |
| three.js, React Three Fiber and drei (`three-*.js`) | 901.4 kB | 195.0 kB | 236.6 kB | After startup, 3D mode only |
| Field renderer (`Field3D-*.js`, `FieldCanvas-*.js`) | 53.6 kB | 16.3 kB | 18.1 kB | After startup, 3D mode only |
| Team page (`TeamView-*.js`) | 13.0 kB | 3.7 kB | 4.1 kB | When a team page first opens |
| Watch party dialog (`PartyDialog-*.js`) | 11.9 kB | 4.4 kB | 4.9 kB | When the dialog first opens |

- At startup, a browser that accepts Brotli downloads about 136 kB of JavaScript and CSS (0.4: about 151 kB). The startup JavaScript fell from 501 kB to 408 kB, and from 131 kB to 116 kB with Brotli. Files under 1 kB have no compressed copy and are counted at full size.
- The built `index.html` preloads the seven shared startup chunks, and still no 3D code. The split also produced a few files under 1 kB (icons and small helpers) that load with the chunks that use them.
- The game page, dialogs and palette are fetched when the page is idle, unless the browser asks to save data.
- The server bundle is 332 kB (0.4: 323 kB).

### Performance

Same scenarios as 0.4, recorded on the 0.5 build before the trend wording change.

| Measure | 0.5 | 0.4 |
| --- | --- | --- |
| Fields drawn | 13 views through 1 field canvas, plus the atmosphere canvas | Same |
| Draw calls per frame | 138 to 176 | 138 to 176 |
| Triangles per frame | 23,354 to 25,884 | 23,354 to 25,884 |
| Textures / programs | 33 / 10 | 33 / 10 |
| Average CPU frame cost | 1.48 to 1.97 ms | 1.73 to 2.15 ms |
| Long tasks over 50 ms | 0 | 0 |
| JS heap after 30 s | 34 MB | 24 MB |
| Game page (1 field, replay playing, cameras cycling) | 24 draw calls, 3,584 triangles, 10 programs, 0.55 ms | 23, 3,584, 9, 0.49 ms |

- The game page's extra draw call and program are the stadium's new lamp glow.
- The JS heap after 30 seconds was 10 MB higher. A likely cause, not investigated: in this replay every game on screen now carries up to four hours of captured Kalshi prices in its detail, replaced as the 60x replay moves. Each version was measured in a single run.

### Checked against live data

Nothing was live yet. The only game on 14 September 2026, DEN at KC (8:15 PM ET), was read again at 4:39 PM ET and compared with the 0.4 reading at 3:32 PM.

- **The lines moved before kickoff.** DraftKings' total fell from 43.5 to 42.5, the Kansas City moneyline went from −135 to −130 and Denver's from +114 to +110. Gridiron's Kalshi reader followed the total, pricing the 42.5 contract (51.5 cents) instead of the 43.5 one. Kansas City to win stayed at 54.5 cents.
- **Price history on the persistent server.** The game's detail carried 18 prices: the hourly history since 1:00 AM UTC on 8 September, where a run of unchanged hours keeps only its ends. The game page drew the sparkline and read "KC to win 54.5¢ −1.5¢ since Mon 9:00 PM", with no console errors. That Monday was a week earlier, so the label now shows the date (fix 6).
- **The serverless function** read the same slate and detail through `api/[...path].ts` loaded as plain Node modules: 1 game with Kalshi prices, and 18 prices of history.

### Checked in the browser and in screenshots

- **Game page layout.** At 1440 by 900 the field, drive replay, game flow and tabs stacked down the left column 16 px apart (the field 351 px tall, drive replay 180, game flow 285), and the side panels ran down the right. Before kickoff, the tabs followed the field directly.
- **Captured Kalshi prices in the replay.** For ARI at LAC at Q4 2:04, with ARI ahead 26 to 14, game flow drew Kalshi's line beside ESPN's win probability of ARI above 99%. The odds panel showed LAC to win at 1 cent, 79.5 cents lower than at 3:25 PM.
- **Screenshots** reviewed at 1440 by 900 and 390 by 844 covered the win probability chart with the dashed Kalshi line, the odds panel trend, cards with captured Kalshi chips, the scoreboard's down and distance, and the phone game page.

### Problems found and fixed during 0.5 verification

1. **The Vercel function would not load.** See above.
2. **Kalshi rate-limited the capture.** The first run captured 5 of the 13 games before 429 responses. The capture script now spaces requests half a second apart, waits and retries after a 429, and skips games already captured.
3. **Two different Kalshi prices on one page.** At Q3 0:18 of the ARI at LAC replay, the chart heading showed 59.5 cents (the price at the latest play) while the odds panel showed 55.5 cents (the price at the replay clock). The heading now names the line, and a price appears only with its own moment: on hover at a play, and in the panel as of now.
4. **A stray white card on phones.** From the phone game page's wider view, a stadium light tower's flat white lamp face sat beside the field like a loose card. The lamps now glow softly.
5. **The legend swatch** for the dashed line drew as a half circle. It is now a short dashed stroke.
6. **An ambiguous trend start.** "Since Mon 9:00 PM" on a Monday meant the Monday before. A start more than six days old now shows its date.
7. **The scoreboard repeated the clock** under its status pill. While play is live, it now shows the down, distance and ball spot there instead.

### Not verified for 0.5

- **A live game**, as for 0.4: win probability after live plays, line movement during a game, Kalshi prices refreshing every 15 seconds, and price history growing minute by minute.
- **Vercel itself.** The function was loaded the way Vercel is reported to load it, but nothing was deployed.
- **A finished game's price history on a live server.** A finished game keeps the history it had, but no game finished while the server ran.
- **Everything listed under Not verified for 0.3** still applies.

## Version 0.4

Recorded Monday 14 September 2026, in the afternoon US Eastern, on the same machine and with the same tools as 0.3. It covers odds and win probability: what was checked, what was fixed along the way, and what could not be verified. After the last test run, only documentation changed.

### Summary

| Check | Result |
| --- | --- |
| Typecheck (`tsc`, strict) | Clean |
| Unit and integration tests (`npm test`) | **430 passed** in 46 files (0.3: 405 in 41) |
| End-to-end journeys in Chrome, production build, replay mode | **60 passed** (0.3: 56), including the accessibility audit |
| `@cross` journeys in WebKit | **7 passed** (0.3: 6) |
| `@cross` journeys in Firefox | **Not run.** Firefox still does not start on this machine (see Version 0.3) |
| Accessibility audit (axe-core, WCAG 2.1 A and AA) | No serious or critical violations on the 6 audited screens. The audited game page now includes the odds panel |
| Design screenshots (`GRIDIRON_CAPTURE=1`) | All 11 capture runs passed; 33 images in `docs/screenshots`, 2 of them new |
| Performance recording (`GRIDIRON_PERF=1`) | 2 runs passed |
| Production build (`npm run build`) | Succeeds |
| Serverless entry (`api/[...path].ts`) served locally, `npm run smoke` | All required checks passed, and the slate carried Kalshi prices |
| Live sportsbook lines, matchup predictor and Kalshi prices | Read for the only game on 14 September 2026, DEN at KC, before kickoff |

The 4 new Chrome journeys cover:

- a win probability meter and the sportsbook line on live cards (also run in WebKit)
- win probability and the closing lines on the game page, switching the odds format, and the note that replays have no Kalshi prices
- game flow switched to win probability, where a big swing opens its play on the field
- turning odds off in Display settings, which removes them from cards and the game page

The 25 new unit tests, in 5 files, cover:

- odds arithmetic and formatting
- ESPN lines, win probability and the matchup predictor, read from captured documents
- Kalshi tickers, team codes, game matching and contract choice, with fictional prices in Kalshi's field names
- the market reader's schedule, its stale and drop rules, and its prices in the engine
- win probability series, merges, deltas and replay clipping

### Bundle

| Chunk | Size | Brotli | gzip | Loads |
| --- | --- | --- | --- | --- |
| App (`index-*.js`) | 469.0 kB | 121.0 kB | 143.2 kB | At startup |
| Shared runtime (`jsx-runtime-*.js`) | 31.7 kB | 10.4 kB | 11.6 kB | At startup, preloaded |
| Styles (`index-*.css`) | 109.8 kB | 19.4 kB | 22.6 kB | At startup |
| three.js, React Three Fiber and drei (`three-*.js`) | 901.4 kB | 195.0 kB | 236.6 kB | After startup, 3D mode only |
| Field renderer (`Field3D-*.js`, `FieldCanvas-*.js`) | 53.2 kB | 16.2 kB | 18.0 kB | After startup, 3D mode only |
| Team page (`TeamView-*.js`) | 12.8 kB | 3.6 kB | 4.0 kB | When a team page first opens |
| Watch party dialog (`PartyDialog-*.js`) | 11.7 kB | 4.4 kB | 4.9 kB | When the dialog first opens |

- At startup, a browser that accepts Brotli downloads about 151 kB of JavaScript and CSS (0.3: about 145 kB). The app chunk grew by about 21 kB (about 5 kB with Brotli) and the styles by about 5 kB (under 1 kB with Brotli). Odds and win probability have no chunk of their own.
- The built `index.html` still preloads only the shared runtime chunk, and no 3D code.
- The server bundle is 323 kB (0.3: 299 kB).

### Performance

Same scenario as 0.3, recorded on the final 0.4 build.

| Measure | 0.4 | 0.3 |
| --- | --- | --- |
| Fields drawn | 13 views through 1 field canvas, plus the atmosphere canvas | Same |
| Resolution | DPR capped at 1 | Same |
| Draw calls per frame | 138 to 176 | 138 to 176 |
| Triangles per frame | 23,354 to 25,884 | 23,354 to 25,884 |
| Textures / programs | 33 / 10 | 33 / 10 |
| Average CPU frame cost | 1.73 to 2.15 ms | 1.63 to 1.90 ms |
| Long tasks over 50 ms | 0 | 0 |
| JS heap after 30 s | 24 MB | 22 MB |
| Game page (1 field, replay playing, cameras cycling) | 23 draw calls, 3,584 triangles, 0.49 ms | 23, 3,584, 0.45 ms |

- The field renderer draws exactly what it drew in 0.3. Odds and win probability are page elements, outside the 3D layer.
- The average CPU frame cost was 0.10 to 0.25 ms higher and the heap 2 MB larger. Each version was measured in a single run, and the difference was not investigated.

### Checked against live data

Nothing was live. The only game on 14 September 2026, DEN at KC (8:15 PM ET), was read before kickoff.

- **Sportsbook lines and predictor (ESPN).** At 3:32 PM ET the running server reported these DraftKings lines, the same values the game page had shown in the in-app browser earlier in the afternoon:
  - Spread: KC −2.5 at −108 (opened −2.5 at −120); DEN +2.5 at −112 (opened +2.5 at +100)
  - Moneyline: KC −135 (opened −155); DEN +114 (opened +130)
  - Total: 43.5, over at −108 and under at −112 (opened 42.5, both at −110)
  - ESPN's matchup predictor: KC 59.6%, DEN 40.1%
- **Kalshi.** In the same reading, KC to win traded at 54.5 cents (bid 54, ask 55) and DEN at 45.5 (bid 45, ask 46). KC to win by more than 2.5 points was 48.5, and over 43.5 points 47.5. In American format the game page showed KC −120, DEN +120, +106 and +111. Health reported 1 matched game and no failed reads.
- **The serverless entry.** `api/[...path].ts` was served on this machine as in 0.3, at 3:33 PM ET.
  - The first slate request answered in 1.38 seconds with Kalshi prices attached, including contract discovery. The next two answered in 38 and 25 ms.
  - Health reported transport poll, markets available, 6 reads and no failures. `npm run smoke` passed every required check.
  - Its slate carried no matchup predictor, because ESPN's scoreboard does not report one. In the code, the polled client reads the detail of games on screen every 25 seconds, and cards merge it in. That was not checked in a browser against this entry.
- **Polymarket** was also examined. Its public NFL series returned no game events, so it is not used.

### Checked in the browser

- **DEN at KC against the live feed.** The game page showed the predictor meter, the DraftKings table with opening values and the Kalshi table in American format, with no console errors.
- **A final game in the replay lab.** ARI at LAC ended 26-14 at the end of the NFL Week 1 replay. Its closing lines were LAC −8.5 at −120 and ARI +8.5 at even money (both opened at 11.5), moneyline ARI +370 and LAC −485, and total 47.5. The panel read "ARI covered +8.5" and "Under 47.5, 40 points", which is correct.
- **Screenshots** of the odds panel, the win probability chart and slate cards with meters and price chips were reviewed at 1440 by 900 and showed no problems.

### Problems found and fixed during 0.4 verification

1. **Market prices waited five minutes after a start.** The reader's first pass ran before the engine had read a slate, found no games and waited the idle interval. While it has no games, it now looks again after 5 seconds.
2. **Screen readers ran odds together.** A line and its price were separate elements with no space between them, so the accessible text read "+2.5−112". The panel now separates them, which was checked in the browser against the live feed.

### Not verified for 0.4

- **A live game.** Win probability after each live play, line movement during a game and Kalshi prices refreshing every 15 seconds were not observed. In-game win probability was verified with captured games in the replay lab. Gridiron reads the last play's win probability from ESPN's scoreboard (`situation.lastPlay.probability`) when present, but no captured scoreboard had it. Without it, cards take win probability from the game's detail, read every 25 seconds for games on screen.
- **Kalshi during and after a game.** Prices were read only before kickoff. How Kalshi lists a game's contracts once it starts and ends was not observed.
- **Kalshi for college games.** No college game was on the day's slate, so none was matched against Kalshi's live listings. College matching was tested only with fictional prices.
- **Everything listed under Not verified for 0.3** still applies: Firefox, the Safari app, Vercel itself, Docker and GitHub Actions, real push delivery, Sportradar, Document Picture-in-Picture and devices.

## Version 0.3

Recorded Monday 14 September 2026 on macOS 27.0 (beta, build 26A5425a) with Node 24.15, Google Chrome 152.0.7977.83, Playwright 1.63.0 (WebKit build 2359) and axe-core 4.13.0. It covers what was checked for 0.3, what was fixed along the way, and what could not be verified.

### Summary

| Check | Result |
| --- | --- |
| Typecheck (`tsc`, strict) | Clean |
| Unit and integration tests (`npm test`) | **405 passed** in 41 files (0.2: 192 in 24) |
| End-to-end journeys in Chrome, production build, replay mode | **56 passed** (0.2: 42), including the accessibility audit |
| `@cross` journeys in WebKit | **6 passed** |
| `@cross` journeys in Firefox | **Not run.** Firefox would not start on this machine (see below) |
| Accessibility audit (axe-core, WCAG 2.1 A and AA) | No serious or critical violations on the 6 audited screens |
| Design screenshots (`GRIDIRON_CAPTURE=1`) | 31 images in `docs/screenshots`, 3 of them new. The final pass recaptured 28 after the last fixes; the watch party, empty day and palette images come from the previous 0.3 pass |
| Performance recording (`GRIDIRON_PERF=1`) | 2 runs passed, on the 0.3 build before the last three fixes (see Performance) |
| Production build (`npm run build`) | Succeeds |
| Serverless entry (`api/[...path].ts`) served locally, `npm run smoke` | All required checks passed |

The 14 new Chrome journeys cover:

- the drive strip on cards and the drive chart on the game page
- team pages, shown as of the replay clock
- a watch party across two browsers: follow the host, explore, return and see the party ended
- push alerts saying plainly that they are unavailable in a replay
- the not-found page
- the pop-out tracker
- the synthetic lateral position scenario
- the axe-core audit, on six screens
- a guard that nothing between a field and the page forms a stacking context

Three existing journeys also run in Firefox and WebKit (`@cross`). New unit tests cover drive tracks, team documents and replay-safe team pages, watch party state and routes, rate limits, QR codes, Web Push encryption and VAPID, the push subscription store, service and routes, the Sportradar adapter and its push stream, pushed updates in the engine, lateral estimates, and reloads for missing code chunks.

### Bundle

| Chunk | Size | Brotli | gzip | Loads |
| --- | --- | --- | --- | --- |
| App (`index-*.js`) | 448.2 kB | 116.3 kB | 137.5 kB | At startup |
| Shared runtime (`jsx-runtime-*.js`) | 31.5 kB | 10.3 kB | 11.5 kB | At startup, preloaded |
| Styles (`index-*.css`) | 105.0 kB | 18.6 kB | 21.7 kB | At startup |
| three.js, React Three Fiber and drei (`three-*.js`) | 901.3 kB | 194.8 kB | 236.6 kB | After startup, 3D mode only |
| Field renderer (`Field3D-*.js`, `FieldCanvas-*.js`) | 53.1 kB | 16.1 kB | 17.9 kB | After startup, 3D mode only |
| Team page (`TeamView-*.js`) | 12.7 kB | 3.6 kB | 4.0 kB | When a team page first opens |
| Watch party dialog (`PartyDialog-*.js`) | 11.7 kB | 4.3 kB | 4.8 kB | When the dialog first opens |

- At startup, a browser that accepts Brotli downloads about 145 kB of JavaScript and CSS (0.2: about 123 kB).
- Loading the team page and the watch party dialog on first use took about 22 kB off the startup JavaScript (about 3 kB with Brotli).
- The built `index.html` preloads only the shared runtime chunk. It preloads no 3D code.
- The server bundle is 299 kB.

### Performance

Same scenario as 0.2: production build, `nfl-week1-sunday` from 35% at 60x, headless Chrome, viewport 1920 by 3200. It was recorded on the 0.3 build before the last three fixes (the game page field wrapper, missing-chunk reloads and the scrolled header). None of them changes what the 3D layer draws.

| Measure | 0.3 | 0.2 |
| --- | --- | --- |
| Fields drawn | 13 views through 1 field canvas, plus the atmosphere canvas | 13 views through 1 canvas |
| Resolution | DPR capped at 1 | Same |
| Draw calls per frame | 138 to 176 | 106 to 126 |
| Triangles per frame | 23,354 to 25,884 | 22,656 to 25,098 |
| Textures / programs | 33 / 10 | 30 / 6 |
| Average CPU frame cost | 1.63 to 1.90 ms | 1.06 to 1.30 ms |
| Long tasks over 50 ms | 0 | 0 |
| JS heap after 30 s | 22 MB | 20 MB |
| Game page (1 field, replay playing, cameras cycling) | 23 draw calls, 3,584 triangles, 0.45 ms | 14, 2,530, 0.29 ms |

- The holographic fields add light sheets, beams, trails and a lit rim, and the game page adds the stadium. The extra draw calls and programs were not broken down further.
- The average CPU frame cost rose by about 0.6 ms. No long tasks were recorded.
- The frame numbers come from the field renderer. The atmosphere draws in its own small canvas and is not counted in them.
- Each version was measured in a single run in headless Chrome, whose GPU backend was not recorded. Treat frame costs as CPU-side measurements on this machine only.

### Checked in the browser and locally

- **The serverless entry.** `api/[...path].ts` was served by a plain Node server on this machine and checked with `npm run smoke` against the live ESPN feed. It reported health (mode live, transport poll), the slate (1 game on 14 September 2026, DEN at KC, scheduled), game detail, no stream and no replay lab. By hand:
  - `/api/team/nfl-12` answered 200 with `s-maxage=60`, and a malformed team id answered 400.
  - Creating a watch party answered 503 with the reason.
  - `/api/push/key` answered `available: false` with the reason.
  - `/api/stream` answered 404.
- **Game page layering.** In headless Chrome at 1440 by 900 with the stadium, the camera buttons, zoom controls and orbit hint were covered by the stadium (fix 1 below). After the fix, a screenshot showed all of them above it.
- **Screenshots** of the slate, game page, team page and watch party dialog were reviewed at 1440 by 900. The replay note, bye week, schedule and QR code rendered as expected.

### Problems found and fixed during 0.3 verification

1. **The stadium covered the game page's controls.** At 1100 px and wider, the field's wrapper was sticky. A sticky box forms a stacking context, so the camera buttons, zoom controls, orbit hint and field labels were painted under the shared WebGL canvas, and the new stadium drew across them. Nothing had been drawn behind them before 0.3, which hid the problem. The wrapper is no longer sticky, and a new journey checks that nothing between a field and the page forms a stacking context. An earlier look at the same symptom had wrongly blamed low contrast against the stadium lights.
2. **The focus trap leaked in Alert settings.** The push section disables its controls with a disabled fieldset. The trap counted those controls as focusable, so Tab moved focus out of the dialog. The trap now skips disabled, inert and hidden controls, and brings back focus that leaves the dialog.
3. **A watch party guest could stay "following" after moving away.** A move made within 1.5 seconds of the host's view arriving was ignored. Moves the party makes are now marked, so any page change the guest makes counts as exploring.
4. **2D mode still created a WebGL context** for the page atmosphere. 2D mode now leaves the atmosphere out.
5. **A missing on-demand chunk could break the page.** The team page and watch party dialog now load on first use. If their code is missing after a new deploy, the page reloads, at most once every ten minutes. After that, the team page shows its recovery panel and the watch party dialog says it could not load. The 3D layer follows the same rule, which also rules out a reload loop.
6. **The scrolled header showed large numerals through it** at Night. It now turns nearly opaque once the page scrolls.
7. **Test fixes that did not change the product:**
   - The Day theme audit ran during the theme cross-fade, so it measured colors halfway between the themes. It now starts in the Day theme.
   - Canvas counts now target the field canvas rather than every canvas on the page.
   - Choosing a team in the palette now opens its team page, so the favorites journey stars the team with Shift.
8. **Documentation claims were checked against the code and corrected:**
   - The Sportradar request rate does not change with the access level.
   - Play-by-play carries each play's situations.
   - Rate limits cover the watch party and push endpoints, not every write endpoint.
   - Replay lab sessions never send push alerts, while a replay-only test server can.
   - The stadium and camera fly-in need Full effects.

### Not verified for 0.3

- **Firefox.** Playwright's Firefox build (1543) exits at launch with "Could not find profile folder" on macOS 27.0 beta, both inside and outside the command sandbox, so no Firefox journey ran. The CI workflow runs Firefox on Ubuntu, but it has not run yet.
- **Safari itself.** The WebKit journeys used Playwright's WebKit build, not the Safari app.
- **A live game.** Nothing was live during the build. In-game behavior was verified with captured games in the replay lab.
- **Real push delivery.** No message went to Google, Mozilla, Apple or Windows push services, and no browser showed a notification. Encryption, signing and delivery were tested against a local receiver.
- **Sportradar.** No key was used, and the real API was never called.
- **Document Picture-in-Picture.** The pop-out was tested with a stand-in popup, because headless Chrome does not offer the API.
- **Vercel, Docker and GitHub Actions.** Nothing was deployed, the Docker image was not built, and the workflow has not run.
- **Performance after the last three fixes.** It was not recorded again.
- **Devices.** Installing the app, push permission prompts, the scoreboard swipe and offline starts were not tried on phones or tablets.
- **Visual effects.** The atmosphere, holographic light, stadium, fly-in and touchdown column were reviewed in screenshots, not asserted frame by frame.

## Version 0.2

Recorded Monday 14 September 2026 on the same macOS machine, with Node 20+ and Google Chrome 152. It covers what was checked for 0.2, what was fixed along the way, and what could not be verified.

### Summary

| Check | Result |
| --- | --- |
| Typecheck (`tsc`, strict) | Clean |
| Unit and integration tests (`npm test`) | **192 passed** in 24 files (0.1: 158 in 17) |
| End-to-end journeys (`npm run test:e2e`), production build, replay mode, Chrome | **42 passed** (0.1: 30) |
| Design screenshots (`GRIDIRON_CAPTURE=1`) | 9 capture runs passed; 28 images in `docs/screenshots`, 6 of them new |
| Performance recording (`GRIDIRON_PERF=1`) | 2 runs passed; `docs/perf.json`, `docs/perf-game.json` |
| Production build (`npm run build`) | Succeeds, with Brotli and gzip copies of text assets |

The 12 new journeys cover:

- the Director in Focus and on the wall
- While you were away
- game flow
- leaders, including hiding them mid-replay
- previous and next game
- keyboard card navigation
- System appearance
- moment thumbnails
- the manifest and service worker
- compression and missing-chunk 404s

New unit tests cover the Director, the digest, game flow and its statistics, leader normalization, play readouts, and HTTP compression.

### Bundle

| Chunk | Size | Brotli | gzip | Loads |
| --- | --- | --- | --- | --- |
| App (`index-*.js`) | 427.5 kB | 111.5 kB | 131.7 kB | At startup |
| Styles (`index-*.css`) | 58.5 kB | 11.0 kB | 12.5 kB | At startup |
| three.js, React Three Fiber and drei (`three-*.js`) | 898.7 kB | 194.3 kB | 235.8 kB | After startup, 3D mode only |
| Field renderer (`Field3D-*.js`, `FieldCanvas-*.js`) | 44.0 kB | 13.3 kB | 14.8 kB | After startup, 3D mode only |

- In 0.1 the client was one 1,333 kB chunk (373 kB gzip).
- At startup, a browser that accepts Brotli downloads about 123 kB of JavaScript and CSS.
- The built `index.html` preloads no 3D code.
- On the local production server, the 3D chunks were requested after the app started: about 30 ms after the entry script, and in parallel with the first render. In 2D mode the page requested only the entry script, and no 3D chunk at all.
- A game page drew one canvas with one registered view, and the service worker was active.

### Performance

Same scenario and environment as 0.1: production build, `nfl-week1-sunday` from 35% at 60x, headless Chrome, viewport 1920 by 3200.

| Measure | 0.2 | 0.1 |
| --- | --- | --- |
| Fields drawn | 13 views through 1 canvas | Same |
| Resolution | DPR capped at 1 | Same |
| Draw calls per frame | 106 to 126 | 113 to 125 |
| Triangles per frame | 22,656 to 25,098 | about 24,000 |
| Textures / programs | 30 / 6 | 30 / 6 |
| Average CPU frame cost | 1.06 to 1.30 ms | 0.99 to 1.13 ms |
| Long tasks over 50 ms | 0 | 0 |
| JS heap after 30 s | 20 MB | 26 MB |
| Game page (1 field, replay playing, cameras cycling) | 14 draw calls, 2,530 triangles, 0.29 ms | 14, about 2,500, 0.28 ms |

The average frame cost was 0.07 to 0.17 ms higher than in 0.1. Each version was measured in a single run, and the difference was not investigated.

### Checked in the browser

These were checked in the in-app browser against the replay lab, on the dev server and the production server.

- **Director.**
  - In Focus at 50% of the NFL replay, it followed GB at MIN, first with "Just happened" and the interception, then with the Watch next reason.
  - On the wall, it took four cells and the grid never repeated its game.
  - At 72%, with nothing live, it showed "Up next · DAL at NYG, kickoff Sun 8:20 PM" with that game's card.
- **While you were away.** I hid the page at 55% of the replay and seeked to 72%. Coming back produced "10 scores · 6 turnovers · 4 finals across 4 games", each play linking to the field.
- **Game flow.** For ARI at LAC, final 26-14:
  - It showed a largest lead of ARI +12, 0 lead changes and 1 tie.
  - Hovering a point named the score, and clicking it opened the historical view.
- **Leaders.** All six headshots loaded at 120 by 87 through the provider's image resizer on `a.espncdn.com`. That host was already allowed by the Content Security Policy. Attendance was listed in Game info.
- **Play readouts.** Cards showed "Rush +3", "Rush +5" and "Pass +6".

### Problems found and fixed during 0.2 verification

1. **While you were away could come back empty.** A second hidden event, while the page was already hidden, replaced the snapshot taken on leaving. It now keeps the first snapshot.
2. **A reconnect cleared the pending summary.** Reconnecting to the same replay session counted as a new source. Now only a different feed or session clears it.
3. **The context-loss journey raced the lazy renderer.** It found the canvas element before the renderer existed, so it never actually lost a context. The test now waits for the renderer; the product's behavior was unchanged.
4. **Wall tiles squeezed their fields.** At 1440 by 900, nine comfortable tiles left each field about 50 px tall, drawn as a thin strip. Two changes fix it:
   - Tiles are now size containers. Under 360 px tall they drop the last-play line, and under 260 px the team names and records, so the field slot grew to 79 px.
   - Card cameras look from lower in slots much wider than they are tall, so the field uses the tile's width.
5. **An idle Director tile was an empty box.** It now shows the next kickoff.
6. **The Director's wording.** Its breaking reason read "Just happened: Interception: MIN ball". It now uses the same separator as other reasons.
7. **A capture step waited on a suspended field.** After scrolling to the game flow chart, the 3D field is off screen and unmounted. The capture now waits on the chart.
8. **The 3D chunk still loaded at startup.** Grouping three.js with `manualChunks` also captured shared dependencies. The entry therefore imported the 3D chunk, and `index.html` preloaded it, so 930 kB was fetched at startup. Chunks are now split automatically and only named, and the built HTML preloads no 3D code.
9. **The server reported version 0.1.0.** The version came from an npm environment variable with a hard-coded fallback. It is now read from `package.json` when the server is built.

### Not verified for 0.2

- **Installing as an app** on phones or desktops, and starting through the service worker during a real network drop.
- **The scoreboard swipe** on touch hardware.
- **The first-down sweep and the team-colored touchdown glow.** Their triggers are unit-tested. The rendering was not asserted or reviewed frame by frame.
- **Leaders during a live game.** Nothing was live. Leaders were verified from captured final summaries and unit tests.
- **The image resizer's stability.** Like the rest of the provider, it is undocumented. If a resized headshot fails, Gridiron falls back to the original image, then to initials.

## Version 0.1

Recorded Monday 14 September 2026, before 4 AM US Eastern, on macOS with Node 20+ and Google Chrome 152. This covers what was checked, how, what it showed, what was fixed along the way, and what could not be verified.

### Summary

| Check | Result |
| --- | --- |
| Typecheck (`tsc`, strict) | Clean |
| Unit and integration tests (`npm test`) | **158 passed** in 17 files |
| End-to-end journeys (`npm run test:e2e`), production build, replay mode, Chrome | **30 passed** (41.5 s) |
| Design screenshots (`GRIDIRON_CAPTURE=1`) | 8 capture runs passed; 22 images in `docs/screenshots` |
| Performance recording (`GRIDIRON_PERF=1`) | 2 runs passed; `docs/perf.json`, `docs/perf-game.json` |
| Smoke test against the live ESPN-backed server (`npm run smoke`) | All required checks passed |
| Production build (`npm run build`) | Succeeds |

### Live data (real ESPN endpoints)

No game was in progress during the build. The live feed was exercised for the states that did exist:

- **Today, 14 September 2026:**
  - Health: mode live, transport SSE, provider day `20260914`.
  - Slate: 1 game (Broncos at Chiefs, scheduled 8:15 PM ET). The NFL, FBS and FCS feeds were connected.
  - The page showed the honest empty state: "No games are live right now", with the next kickoff and the previous day's finals.
  - The stream's first event arrived (`hello`).
- **NFL, Sunday 13 September:** 13 games, all final.
  - The overtime game Saints at Lions (Final/OT) normalized to 226 plays, 224 with a reported end spot, 28 drives, 10 scoring plays, 15 team-stat rows and 0 history gaps.
  - The two 0-0 stoppages in that game are first-quarter timeouts before any score, which is correct.
- **College, Saturday 12 September:** 125 games from FBS (80) and FCS (78).
  - Games in both divisions appear once.
  - 25 conferences were named from the provider's group documents.
  - 124 games had full play-by-play; 1 was score-only.

### In-game behavior (replay lab)

Live in-game states were verified by replaying captured real games through the same normalization, engine, stream and client:

- **Slate:** live first, then upcoming and final. Watch next reasons appeared (for example "Overtime · 7-point game" and "Tying or go-ahead chance in the red zone"), along with red-zone and one-score counts.
- **Cards:** reported spots, line of scrimmage and line to gain. "Ball spot unavailable" appears where the feed gave no spot.
- **Game page:** the three cameras and reset, drive replay with a shareable `?play=` link, the new-plays indicator, and filters and search in play-by-play.
- **Alerts:**
  - Arriving mid-game produced no moments. Moments followed as play continued.
  - In the synthetic scenario, a touchdown reversed on review was marked withdrawn and never celebrated twice.
  - During the synthetic provider outage, the league was marked delayed and cards showed "Updates delayed". Scores were not changed or invented, and the page recovered.
- **Graphics fallback:** after a forced WebGL context loss, every field switched to 2D with a notice, then recovered.

### Performance

Environment: production build in replay mode, `nfl-week1-sunday` from 35% at 60x speed. Headless Chrome via Playwright, viewport 1920 by 3200, so all 13 cards are near the viewport. The GPU backend of headless Chrome was not recorded; it may be software rendering. Treat frame costs as CPU-side measurements on this machine only.

| Measure | Result |
| --- | --- |
| Fields drawn | 13 views through **1 canvas** |
| Resolution | DPR capped at 1 (more than 12 views) |
| Draw calls per frame | 113 to 125 |
| Triangles per frame | about 24,000 |
| Textures / programs | 30 / 6 |
| Average CPU frame cost | 0.99 to 1.13 ms (24-frame averages over 30 s) |
| Long tasks over 50 ms while replaying and scrolling | **0** |
| JS heap after 30 s | 26 MB |
| Game page (1 large field, replay playing, cameras cycling) | 14 draw calls, about 2,500 triangles, 0.28 ms CPU per frame |

Bundle: the client JavaScript was 1,333 kB (373 kB gzip), CSS 49.7 kB (10.9 kB gzip) and the server 120 kB. The client shipped as one chunk; the 3D code was not split out until 0.2.

### Problems found and fixed during verification

1. **Blank fields after scrolling.** In on-demand rendering, drei `View` clears a field's rectangle during React's commit when the field comes back on screen, and nothing requested another frame. Fixed with trailing frame requests after scroll, resize and layout changes.
2. **Card camera framing overridden.** R3F and drei reset orthographic cameras to pixel units every frame. Fixed by marking the cameras `manual` and sizing them from each view's element.
3. **Alert flood after a replay seek.** Jumping three hours delivered 99+ moments as if new. Fixed three ways:
   - A seek, delay change or source change starts a fresh baseline.
   - More than three new plays in one update are marked "Late update".
   - Toasts arriving within 2.5 s of each other are grouped.
4. **A provider quirk: a 0-0 score on a stoppage.** A captured two-minute warning reported 0-0 after 59-37, which made a card show 0-0 and raised "Tied late". Fixed in the normalizer and the replay timeline, with a test against the captured game.
5. **Card and game page disagreeing on the spot.** A newer scoreboard report can drop the spot between snaps. While play is running, the card now shows where the last reported play ended, labeled "Last known spot". It does not do this at halftime.
6. **Replay session expiry.** After a server restart, the client waited forever. The replay bar now says the session ended and offers Start again.
7. **Layout and design polish from the screenshot review:**
   - The header was too translucent.
   - The replay tag had low contrast on the dark bar.
   - The 16-game wall clipped its last row when the replay bar was shown.
   - The isometric camera sat too far back.
   - Star buttons crowded the scores.
   - Catch-up items ran too tall.
   - The goal line showed as "MIN 0"; it now reads "MIN goal line".
8. **Test selectors.** Six end-to-end selectors were ambiguous and were fixed: `play=` also matched `replay=`, the header and rail both have "Alert settings", and selects count as comboboxes and options.

### Not verified, and why

- **A live game.** No NFL or college game was in progress while this was built. In-game behavior (live situations, play animation timing against real poll cadence, alerts from live plays, late-night date rollover) was verified with captured real games in the replay lab, not against a live broadcast. The first live window after the build is Broncos at Chiefs, 8:15 PM ET on 14 September 2026.
- **Browsers other than Chrome.** Safari and Firefox were not tested.
- **Real devices.** Phone and tablet layouts were checked at 390 and 768 px in Chrome's viewport, not on hardware. Touch orbit on the game page was not exercised.
- **Audio output and the browser notification prompt.** Automation checked that sound and notifications are off by default and change only through their toggles. It did not check that a chime was audible or that the OS permission prompt appeared.
- **An automated accessibility audit.** None was run; no audit tool was installed. Keyboard access, the skip link, the focus trap, Escape, focus return, the live region and reduced motion were verified.
- **The Vercel deployment.** It was not deployed (no credentials, and nothing was to be published). The serverless adapter typechecks and shares the server's code path; its behavior on Vercel is unverified.
- **Divisions II and III against the live feed.** They were verified with captured group and scoreboard data and unit tests, not requested live in this run.
- **A licensed provider.** Sportradar is documented as a seam only. No code for it exists, and nothing was tested against it.
- **ESPN stability.** The endpoints are undocumented and can change or rate-limit without notice. Gridiron reports failures instead of hiding them; it cannot prevent them.
