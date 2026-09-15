# Changelog

## 0.5.2

14 September 2026

### Fixed

- **"No games on this day" while ESPN was refusing.** On the evening of 14 September, ESPN's servers refused requests from the Vercel deployment for a while (HTTP 403), then answered again. Gridiron marked NFL and college data unavailable, as it should, but the page beneath the notices still said "No games on this day.", "No kickoffs found in the next seven days." and "No recent final scores found." Those games were unknown, not absent.
  - When a league's feed has not answered for the day, the slate says "Games could not be loaded." (or speaks only for the leagues that did answer), the summary strip names the unavailable data instead of "Nothing in progress", and the wall does the same.
  - Looking ahead for kickoffs and back for results counts a day the provider did not answer for as a failed lookup, says so, and asks again after a minute instead of remembering the day as empty for ten.
- **Failures clear sooner on Vercel.** A slate or game the provider never answered for is shared by the CDN for 2 seconds, without stale reuse, instead of 10 seconds plus 30 of stale reuse, so a recovery reaches viewers at once.
- **A warm Vercel instance kept its first answer.** Nothing polls between requests on Vercel, and a function instance that had already fetched a day's slate never fetched it again while it stayed warm. After ESPN's refusal, such an instance kept answering "unavailable" even once ESPN answered again, and a healthy one could keep serving its first scoreboard. On the evening of 14 September the live site answered, during the game, with a scoreboard it had last read 30 minutes earlier.
  - A request now refreshes a slate once its polling interval has passed: 25 seconds while games are live or kick off within 45 minutes, 5 minutes otherwise, and 30 minutes for past days. A game is refreshed after 12 seconds, as before.
  - Both count as due 3 seconds early. Viewers poll on the same cycle, so a request arriving a moment early would otherwise wait out a whole further cycle, and a single viewer could see only every other update.
  - A refused slate is asked for again after 30 seconds, and a failing game at most every 10 seconds, so a refusal is not answered with a request on every page load.

## 0.5.1

14 September 2026

### Fixed

- **Game pages and team pages on Vercel.** Outside Next.js, Vercel does not treat `api/[...path].ts` as a catch-all. It matched a single path segment, so `/api/slate` worked while `/api/game/<id>`, `/api/team/<id>` and `/api/push/key` got Vercel's own 404. On a Vercel deployment every game page, past or live, showed no play-by-play, drives, scoring or team stats, and team pages could not load.
  - The function is now `api/index.ts`, and a rewrite in `vercel.json` sends every `/api/...` request to it with the original path, which the function restores before routing.
  - `npm run check:serverless` now also sends requests the way the rewrite delivers them, and with `--live` loads the latest finished game's play-by-play.
- **Games that have not started** are no longer described as score-only on the game page. ESPN's game summary reports play-by-play as unavailable before kickoff, which the scoreboard reading already allowed for.

## 0.5.0

14 September 2026

### New

- **Kalshi beside ESPN, play by play.** Game flow's win probability view draws Kalshi's price for the home team to win as a dashed line on the same scale. Each price sits between the plays around it by time, and the line never runs past the latest play shown. Pointing at any play names both.
- **Price trend.** The odds panel adds a sparkline of the home team's Kalshi price and how far it has moved: over the week before kickoff, or from an hour before kickoff once the game starts. A finished game keeps its in-game trend.
  - The prices come from Kalshi's public price history, hourly over the week before kickoff and minute by minute from an hour before. They refresh every 45 seconds while a game is live, arrive with the game's detail and follow the spoiler delay.
- **Kalshi in the replay lab.** The NFL Week 1 replay now carries Kalshi's prices for all 13 games, captured minute by minute and cut at the replay clock like the plays, so replays show the market as it traded. Synthetic test scenarios never get them. `npx tsx scripts/capture-kalshi.ts` captures prices for a real replay.

### Improved

- **The Vercel deployment loads.** Vercel runs `api/` functions as Node ES modules, which cannot resolve extensionless imports, so the 0.4 function would have failed to load on every API request. Every server import now names its file, and the version comes from `shared/version.ts` instead of a JSON import. `npm run check:serverless` loads the function the way Vercel does, and CI runs it.
- **A fuller game page.** On wide screens the field, drive replay, game flow and play-by-play run down the left and the panels down the right, so neither column leaves a tall empty space. On phones, drive replay sits right under the field.
- **A lighter start.** The game page, the settings dialogs and the command palette load on first use. Their code is fetched once the page is idle, so they still open at once.
- The scoreboard shows the down, distance and ball spot under the clock, instead of repeating the clock.
- The stadium's light towers glow, instead of showing flat white panels that looked like a stray card from a phone's wider view.

## 0.4.0

14 September 2026

### New

- **Live win probability.** ESPN's win probability after every reported play appears on live cards as a slim meter in team colors, with the change the latest play made. Before kickoff, cards show ESPN's matchup predictor instead.
  - The game page has an Odds and win probability panel. While you step through a drive, it shows the value after that play and the swing the play made.
  - Game flow switches between the score margin and win probability. The biggest swings are marked, and selecting one, or any point on the line, opens that play on the field.
  - Every value is ESPN's own. Gridiron never calculates a chance.
- **Sportsbook lines.** Spread, moneyline and total from the sportsbook ESPN reports (DraftKings, for every game captured in September 2026), with the opening and latest lines. Cards show the spread and total. The game page shows all three, and after a game, how the result compared with the closing lines.
- **Kalshi prices, with no account or key.** The server reads Kalshi's public market data: each team's contract to win, and the spread and total contracts nearest the sportsbook's lines.
  - Prices refresh about every 15 seconds while a game is live, are shared by every viewer, and are marked when they may be out of date.
  - Cards show the market favorite's price. College games appear when Kalshi's team codes match ESPN's.
- **Odds formats.** American, decimal, or the chance odds imply, in Display settings or on the panel itself. Odds and win probability can be turned off entirely.
- Odds and win probability follow the spoiler delay and arrive through the same stream as scores. The pop-out tracker shows the win probability meter too.
- The replay lab includes the captured closing lines, and ESPN's win probability cut at the replay clock, for every replayed game that has them. Replays never show Kalshi prices.

### Improved

- Each live card's screen reader summary includes the win probability.
- The Vercel deployment reads Kalshi prices when a slate is requested, waiting at most 3 seconds. `GRIDIRON_MARKETS=off` turns market prices off on either deployment, and `/api/health` reports their status.

## 0.3.0

14 September 2026

### New

- **A holographic look.** Dark is now the default appearance; light remains one click away.
  - A live WebGL atmosphere sits behind the page: a grid floor, horizon glow, light beams and drifting dust that lean with the pointer. It holds a still frame when effects are reduced and pauses while the tab is hidden. 2D mode leaves it out, so nothing on the page uses WebGL.
  - Cards and panels are glass, with gradient edges and corner brackets. At Night with Full effects, a light circles the edge of each live card and a sheen passes across it. Numerals glow, a soft light follows the pointer, and a hovered card glows in the home team's color.
  - A short boot sequence on the first visit of a session, view transitions between pages, and a sliding indicator on segmented controls.
- **Holographic fields.** Fields are drawn in light by default: glowing lines and numbers, team end zones, a glass base with a lit rim, sheets of light at the line of scrimmage and the line to gain, a beam over the ball and glowing trails. A touchdown raises a column of light and sparks in the scoring team's color. Classic turf is still in Display settings.
  - Card cameras lean toward the pointer. With Full effects, the game page flies in over a stadium of tiered stands, seat lights and light towers. The stadium is decoration, not the real venue.
- **Drive tracker.** Every live card carries a strip of the current drive: where it started, where each reported play ended, the line to gain and the ball, with plays, yards and time.
  - The game page adds a drive chart that draws every play as an arrow across the field.
  - While a play is inspected, the chart shows that play's drive up to that play.
  - Only reported spots are drawn. A play without one keeps its row and says so.
- **Team pages** at `/team/<id>`. Each has a holographic team hero, the record, streak and points, the next game and last result, the season as a timeline with bye weeks, scoring margins and the full schedule. Scoreboards and search link to them.
  - In the replay lab, results after the replay clock are hidden.
  - So are the record, rank and standing, which the provider reports only as of today.
- **Watch parties.** Start a party and share its link or QR code. Everyone who joins follows your view as it changes: the page, focused games, a replay and its clock, an inspected play and the spoiler delay.
  - Guests can explore on their own and come back at any time.
  - A party carries only that view, nothing personal.
- **Push alerts** for favorite teams, from the persistent server.
  - The server runs the same alert engine as the app on the games of subscribed teams. It sends encrypted Web Push notifications when real plays and scores are reported, even while Gridiron is closed.
  - Choose the kinds of moments, send a test, and turn alerts off at any time.
  - A correction replaces the notification it corrects. Replay lab sessions never send alerts.
- **Pop-out tracker.** In browsers with Document Picture-in-Picture, the game page opens a small always-on-top window with the score, clock, situation, drive strip and latest play.
- **Licensed data.** A Sportradar adapter for the NFL and NCAA Football v7 APIs, behind `GRIDIRON_PROVIDER=sportradar`.
  - Keys come from the environment. Requests are limited per key, and push streams are used on production access.
  - The engine now accepts pushed updates through the same merge and versioning as polls.
  - It was built from Sportradar's public documentation and tested only against fictional fixtures.
- **Lateral ball position.** Fields place the ball across the field when the data carries a lateral position. No live provider reports one, so a new synthetic test scenario estimates it from play descriptions to show the feature, and is labeled that way.
- **Accessibility audit and more browsers.** An axe-core audit covers the slate in both themes, a game page, a team page, the dialogs and the not-found page. Key journeys also run in Firefox and WebKit.
- **Deployment.** A Dockerfile, a GitHub Actions workflow, an environment example, a share image with page metadata, robots.txt and install shortcuts.

### Improved

- A designed not-found page, and a recovery panel when a view fails instead of a blank page.
- Watch party and push endpoints are rate limited and refuse cross-site writes. A graceful shutdown saves push subscriptions and closes live streams.
- Modal dialogs keep focus inside when a control in them is disabled or removed.
- The game page's camera controls, hints and field labels always draw above the 3D view. The field no longer stays pinned while the side panels scroll, because pinning put those controls underneath the 3D layer; inspecting a play still brings the field into view.
- If code that loads on demand has gone missing after a new deploy, the page reloads to fetch the new version, at most once every ten minutes.
- The game page camera controls wrap before they reach the orbit hint, and hints stay legible over the stadium lights.
- Header controls that scroll sideways on narrower screens fade at the edge.
- The command palette opens team pages and the watch party.

## 0.2.0

14 September 2026

### New

- **Director mode.** Focus can hand its first slot to the Director, and the wall can give it a large tile.
  - It follows the most important live situation and always says why: the Watch next reason, or the moment that was just reported.
  - It stays at least 45 seconds on a game. It moves to a touchdown, turnover, safety, lead change or overtime elsewhere within 25 seconds of the report, once it has spent 12 seconds on the current game. It never cuts away twice for the same moment.
  - **Stay** holds the current game. **Skip** sets it aside for 3 minutes.
  - When nothing is live, it shows the next kickoff.
- **While you were away.** Come back to the tab after 4 minutes or more, or reopen Gridiron later the same day (within 12 hours). The slate opens with what was reported in the meantime.
  - Scores, turnovers, kickoffs and finals for each game, with each play linking to the field.
  - It compares snapshots of reported data only and never replays a game's whole history.
  - Dismiss it with one click. A replay compares only within its own session.
- **Game flow.** Every game page has a step chart of the score margin across the game clock, with lead changes, ties and each team's largest lead.
  - Each scoring play is a point. Hover or focus names it, and a click shows it on the field. Arrow keys move between points.
  - College overtime has no clock, so its scores are spaced in reported order.
- **Game leaders and attendance.** Passing, rushing and receiving leaders for each team, with headshots, exactly as the provider reports them.
  - A replay shows them only once the game is final, so the box score is never spoiled.
  - Attendance appears in Game info when it is reported.
- **Play readouts with yardage.** Field labels read "Rush +7", "Pass +18", "Sack −8" and "Penalty +15 · First down". A new set of downs, read only from the reported downs, sweeps the line to gain once.
- **Team-colored touchdowns.** The end zone the ball reached lights up in the scoring team's color.
- **Moment thumbnails.** A moment tied to a play shows a small field strip with the play's reported start and end.
- **Previous and next game.** The game page has previous and next buttons that show the game's position in the slate. The `[` and `]` keys and a swipe across the scoreboard do the same.
- **Keyboard card navigation.** `J` and `K` step through cards, and the arrow keys move across the grid once a card has focus. `F` adds the focused game to Focus and `P` pins it.
- **System appearance.** Choose Light, Dark or System. System follows the device and changes when it does.
- **Install.** Gridiron now has a web app manifest and app icons rendered from the favicon.
  - A service worker keeps the app shell and build files for quick starts.
  - It never caches `/api`, so scores are always current or honestly unavailable.

### Improved

- **Faster first load.** three.js and the field renderer are now separate chunks. They are fetched once the app has started, while the page renders, and never in 2D mode. JavaScript needed to start the app fell from 1,333 kB to 427 kB (112 kB with Brotli).
- **Compression.** The build writes Brotli and gzip copies of text assets, and the Node server sends them with `Vary: Accept-Encoding`. JSON responses of 1.4 kB or more are gzipped.
- **Missing chunks fail cleanly.** A missing hashed file now returns 404 instead of the app shell. If a 3D chunk cannot load, the page reloads once, then falls back to 2D fields.
- **Livelier cards.** A card's camera eases lower while the card is hovered or focused, and cuts in when the Director changes games. Reduced motion turns both off.
- **Legible wall tiles.** A short wall tile now drops the last-play line (and, when very short, the team names) to give its height to the field. Cameras look from lower in wide slots, so the field uses the tile's width.
- **Header and theme polish.** The header gains a soft shadow once the page scrolls, and switching appearance eases colors instead of flashing.

## 0.1.0

13 September 2026

First release: the slate, Focus and the wall; a 3D field for every game; the game page with drive replay; alerts and moments; Watch next; the spoiler delay; boards; the replay lab; and the verification suite.
