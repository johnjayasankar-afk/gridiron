# Gridiron

**Every game. Every drive. One view.**

Gridiron is a live NFL and college football command center. Every game gets its own interactive 3D field showing the reported ball spot, possession, line of scrimmage, line to gain and the latest play's movement, next to the score, the situation, live win probability and odds, the current drive and a moments feed. Team pages, watch parties and push alerts for favorite teams are built in.

An independent product by [John Jayasankar](https://johnjayasankar.com/), part of [Labs](https://labs.johnjayasankar.com/).

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

---

## Contents

- [What is in it](#what-is-in-it)
- [Run it](#run-it)
- [Deploy](#deploy)
- [Data sources and coverage limits](#data-sources-and-coverage-limits)
- [How updates work](#how-updates-work)
- [Odds and win probability](#odds-and-win-probability)
- [Reading the field: schematic conventions](#reading-the-field-schematic-conventions)
- [Replay lab](#replay-lab)
- [Alerts](#alerts)
- [Watch parties](#watch-parties)
- [Graphics and performance](#graphics-and-performance)
- [Licensed providers](#licensed-providers)
- [Accessibility and privacy](#accessibility-and-privacy)
- [Project layout](#project-layout)
- [Testing](#testing)

## What is in it

- **Slate.** A responsive grid with live games first, then upcoming and final. It shows live and monitored counts, notable situations (overtime, one-score games late, red zone, fourth down) and a Watch next strip with the reasons for each pick.
- **Win probability and odds on every card.** A live card shows ESPN's win probability after the latest play as a meter in team colors, with the swing that play made, plus the sportsbook spread and total and the Kalshi price for the market favorite. Before kickoff, the meter shows ESPN's matchup predictor. See [Odds and win probability](#odds-and-win-probability).
- **Drive tracker.** Every live card carries a strip of the current drive: where it started, where each reported play ended, the line to gain and the ball, with plays, yards and time.
- **While you were away.** Come back after 4 minutes or more, or reopen Gridiron later the same day, and the slate opens with what was reported in the meantime. It lists scores, turnovers, kickoffs and finals for each game, and each play links to its view on the field. It is built only from snapshots of reported data.
- **Focus.** One, two or four games at a large size. Each slot can be replaced, moved or cleared.
- **Wall.** Full screen, 4, 9 or 16 games, compact or comfortable, with an exit control and Escape.
- **Director mode** in Focus and on the wall. The first Focus slot, or a large wall tile, follows the most important live situation and names the reason.
  - It holds a game for at least 45 seconds and cuts in for a touchdown, turnover, safety, lead change or overtime elsewhere.
  - **Stay** holds the current game and **Skip** sets it aside for 3 minutes.
  - When nothing is live, it shows the next kickoff.
- **Game page** at `/game/<id>`, shareable:
  - A large 3D field with isometric, broadcast and top-down cameras, reset, and a restrained orbit and zoom. With holographic fields and Full effects, the camera flies in over a decorative stadium.
  - Scoreboard and situation, with previous and next game buttons. The `[` and `]` keys and a swipe across the scoreboard also move between games.
  - An odds and win probability panel: the win probability meter (at the inspected play while you step through a drive), the sportsbook's spread, moneyline and total with opening lines, Kalshi prices with a trend of the home team's price, and after a game how the result compared with the closing lines.
  - A drive chart that draws every reported play of the current drive as an arrow across the field. Selecting a play inspects it.
  - Drive replay: play, pause, step, scrub, speed, scoring jumps, current drive and back to live.
  - Game flow: the score margin across the game clock, with lead changes, ties and largest leads, or win probability play by play with its biggest swings marked and Kalshi's price drawn beside it. Every point opens its play on the field.
  - Passing, rushing and receiving leaders with headshots, as the provider reports them. A replay shows them only once the game is final.
  - A catch-up summary.
  - Play-by-play with filters, search, jump to latest and click-to-inspect. The inspected play is shareable with `?play=`.
  - Drives, scoring timeline, team stats, attendance and broadcast information.
  - **Pop out** a small always-on-top tracker with the score, clock, win probability, situation, drive and latest play, in browsers with Document Picture-in-Picture (desktop Chrome and Edge).
- **Team pages** at `/team/<id>`, linked from scoreboards and search: a holographic team hero, the record, streak and points, the next game and last result, the season as a timeline with bye weeks, scoring margins and the full schedule.
- **Watch parties.** Share a link or QR code, and everyone who joins follows your view as it changes. See [Watch parties](#watch-parties).
- **Push alerts** for favorite teams, delivered even while Gridiron is closed. See [Alerts](#alerts).
- **Header controls:**
  - Live, Today or any date; All, NFL or College; search; the favorite-team filter.
  - Layout, watch party, alert settings, appearance (Light, Dark or System), and a freshness indicator with details.
- **Moments rail.** Collapsible on wide screens, a drawer on phones. Every moment has open, focus and view-play links. A moment tied to a play shows a small field strip of its reported start and end.
- **Command palette** (Cmd or Ctrl+K) and keyboard shortcuts:
  - Search opens games and team pages. Shift+Enter adds a game to Focus or stars a team.
  - `1`, `2`, `3` for the views, `L` for live, `M` for moments, `?` for the list and `Esc`.
  - `J` and `K` step through cards, and the arrow keys move across the grid once a card has focus.
  - `P` pins the focused game and `F` adds it to Focus.
  - `[` and `]` move between games.
- **Boards.** Save, duplicate, rename, delete with undo, and share by link. Team boards follow their teams to whichever day is open.
- **Look.** Dark is the default appearance, with Light and System one click away. Fields are drawn in holographic light by default, with classic turf in Display settings, and effects can be Full, Reduced or 2D.
- **Install.** A web app manifest, icons and shortcuts let Gridiron be installed as an app. In production, a service worker keeps the app shell for quick starts; live data is never cached.
- **Honest empty state.** When nothing is live: the next kickoffs, recent finals, and a clearly labeled replay demo. Gridiron never shows fictional live games.
- **Failures with a way out.** An unknown address shows a not-found page, and a view that fails shows a recovery panel instead of a blank page.

## Run it

Requirements: Node 20.19 or newer.

```bash
npm install
npm run dev
```

- Client: http://localhost:5178 (Vite, proxies `/api` to the server)
- Server: http://127.0.0.1:8787 (shared polling engine, server-sent events, replay lab, watch parties, push alerts, market prices)

To watch without live games, open http://localhost:5178/?replay=nfl-week1-sunday or choose **Replay lab** from the menu.

Production:

```bash
npm run build      # typecheck, client build to dist/ with Brotli and gzip copies, server bundle to dist-server/
npm start          # serves the client and API on PORT (default 8787)
```

To run the production server with no network access, replaying captured data:

```bash
npm run start:replay
```

### Environment

Every setting is optional. [.env.example](.env.example) lists them all with comments.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1`, or `0.0.0.0` when `NODE_ENV=production` | Bind address |
| `GRIDIRON_PROVIDER` | `espn` | `sportradar` uses the licensed adapter (keys below); `replay` serves a captured scenario as the default source |
| `GRIDIRON_REPLAY_SCENARIO` | `nfl-week1-sunday` | Scenario for `GRIDIRON_PROVIDER=replay` |
| `GRIDIRON_STATIC_DIR` | `dist` | Built client; `none` serves the API only |
| `GRIDIRON_CACHE_DIR` | `.cache` | Keeps discovered college divisions, the generated push keys and push subscriptions between restarts; `off` disables |
| `GRIDIRON_FETCH_TIMEOUT_MS` | `9000` | Per-request provider timeout |
| `GRIDIRON_FETCH_CONCURRENCY` | `6` | Concurrent provider requests |
| `GRIDIRON_FETCH_BUDGET` | `150` | Provider requests per minute, across all users |
| `GRIDIRON_POLL_*_S` | see below | Polling intervals, in seconds |
| `GRIDIRON_MAX_STREAMS` | `500` | Concurrent browser streams |
| `GRIDIRON_MAX_REPLAY_SESSIONS` | `25` | Concurrent replay lab sessions; `0` disables the lab |
| `GRIDIRON_TRUST_PROXY` | off | `1` behind a reverse proxy that sets `x-forwarded-for`, so rate limits see each visitor |
| `GRIDIRON_MARKETS` | on | `off` turns Kalshi market prices off |
| `GRIDIRON_PUSH` | on | `off` turns push alerts off |
| `GRIDIRON_VAPID_PUBLIC_KEY`, `GRIDIRON_VAPID_PRIVATE_KEY` | generated | The push key pair. Leave both unset to generate a pair once in the cache directory |
| `GRIDIRON_VAPID_SUBJECT` | `https://labs.johnjayasankar.com/` | An `https:` URL or `mailto:` address push services can use to reach whoever runs the server |
| `GRIDIRON_FIXTURES_DIR` | `fixtures/espn` | Captured responses for the replay lab |
| `GRIDIRON_TEAM_FIXTURES_DIR` | `fixtures/espn/team` | Saved team documents the replay lab reads before the network |
| `SPORTRADAR_*` | none | Licensed provider keys and settings; see [docs/PROVIDERS.md](docs/PROVIDERS.md) |

For development and tests only: `GRIDIRON_API` tells the Vite dev server where to send `/api`, `GRIDIRON_PUSH_REPLAY=1` lets a replay-only server send push alerts (each titled "Replay"), and `GRIDIRON_PUSH_ALLOW_HOSTS` admits a local test push service outside production.

No credentials are needed for the default provider, and none for win probability, sportsbook lines or Kalshi prices. Provider keys and push keys belong in server environment variables or a local, Git-ignored `.env.local`. They are never sent to the browser.

## Deploy

### Persistent Node server (recommended, every feature)

Use any host that keeps a Node process running, such as Render, Fly.io, Railway or a small VM.

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check: `GET /api/health`
- Set `NODE_ENV=production`. The host usually provides `PORT`. Behind a reverse proxy, set `GRIDIRON_TRUST_PROXY=1`.
- Keep the cache directory on persistent storage. It holds the push key pair and push subscriptions; if the keys are lost, every existing subscription stops working. Alternatively, set the key pair in the environment.

A Dockerfile is included:

```bash
docker build -t gridiron .
docker run -p 8787:8787 -v gridiron-cache:/app/.cache gridiron
```

One process polls the provider and Kalshi once for everyone and streams updates to every browser. It serves the built client with a strict Content Security Policy. The replay lab and watch parties live in memory: replay sessions end after 15 idle minutes, and both end when the process restarts. The replay bar then offers **Start again**, and a watch party says it has ended.

Running several instances works, but each one polls separately, and watch parties and push subscriptions belong to the instance that created them. Prefer one instance with room to grow.

### Vercel (bounded)

`vercel.json` and `api/index.ts` are included. Serverless functions cannot hold streams open or poll between requests, so this deployment is deliberately limited:

- Every `/api/...` request reaches the one function through a rewrite in `vercel.json` that carries the original path, and the function restores it before routing. Outside Next.js, Vercel does not treat a `[...path]` file as a catch-all: in 0.5, game detail and team pages got Vercel's own 404.
- The client polls instead of streaming (`/api/health` reports `transport: "poll"`).
- Nothing polls in the background. Each request fetches what it needs within the fetcher's time budget. A request refreshes a slate once its polling interval has passed and a game after 12 seconds, both counted 3 seconds early because viewers poll on the same cycle. It asks again for a refused slate after 30 seconds, and for a failing game at most every 10 seconds.
- Kalshi prices are read when a slate is requested, and a game's Kalshi price history when its detail is, waiting at most 3 seconds each.
- Responses are cached at the edge: slates for 10 seconds, games for 8 and team pages for 60. Concurrent viewers share provider requests. A slate or game the provider did not answer for is cached for 2 seconds, so a recovery shows at once.
- The replay lab, watch parties and push alerts are not offered. The empty state and Alert settings say so, and the header leaves out the watch party button.

Deploy with the Vercel CLI or dashboard. Framework preset: Other. The build and output settings come from `vercel.json`, and no environment variables are needed.

Vercel runs the function as Node ES modules, one transpiled file at a time, so every import in `api/`, `server/` and `shared/` names its `.js` file (TypeScript, Vite, Vitest and esbuild map it to the `.ts` source). `npm run check:serverless` loads the function that way and checks its routes, including requests in the form the rewrite delivers them, and `npm run check:serverless -- --live` also reads today's slate, a game's detail and the latest finished game's play-by-play. CI runs the offline check.

### Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: typecheck, unit tests and the production build, then the end-to-end suite in Chromium, Firefox and WebKit.

## Data sources and coverage limits

Gridiron's default provider is **ESPN's public site API**. The endpoints are undocumented, unofficial and unlicensed:

- Scoreboard: `site.api.espn.com/apis/site/v2/sports/football/{nfl|college-football}/scoreboard?dates=YYYYMMDD&limit=500[&groups=ID]`. Its competitions carry sportsbook `odds`.
- Game summary: `…/summary?event=ID`. It carries sportsbook lines (`pickcenter`), win probability after each play (`winprobability`) and, before kickoff, the matchup predictor (`predictor`).
- Team and season schedule, for team pages: `…/teams/ID` and `…/teams/ID/schedule?season=YYYY&seasontype=1|2|3`
- College group metadata: `sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/{year}/types/{type}/groups`, with its children and group documents

Nothing guarantees their availability, latency, completeness or shape. Every response is validated. A failed or malformed response marks data as delayed or unavailable, with the reason. It is never replaced with other data.

Market prices come from **Kalshi's public market data** (`api.elections.kalshi.com/trade-api/v2`), which needs no account or key: open game events per league, spread and total ladders, batched contract prices, and each followed game's price history (candlesticks). See [docs/PROVIDERS.md](docs/PROVIDERS.md#prediction-markets).

How coverage is discovered:

- The NFL comes from one scoreboard per day.
- College divisions are read from ESPN's own group list for the season: FBS, FCS, Division II and Division III. The college scoreboard for each selected division is fetched separately.
- Games that appear in two divisions (FBS against FCS) are merged into one.
- Days follow US Eastern time, as the provider does. Games still in progress after midnight stay visible in Live mode.
- Conference names for the filter come from the provider's group documents.

Limits to know:

- **College play-by-play is incomplete.** Many games, especially outside FBS, have scores only. Their cards say "Score-only coverage", and they have no win probability.
- Team stats, drives and broadcasts can be missing or late.
- The provider has its own delay. None of this is official real-time tracking.
- ESPN can refuse requests. On 14 September 2026 it answered the Vercel deployment with HTTP 403 for a while, then recovered on its own, while answering other connections normally. Gridiron shows such a day as data unavailable, never as a day without games, and keeps retrying. It does not disguise its requests to get around a refusal.
- No live provider reports where the ball is across the field, so live fields keep the ball on the centre axis.
- Team records, ranks and standings are reported only as of today. The team documents' own bye week field was found to be unreliable, so bye weeks come from gaps in the reported week numbers.
- Nothing was live while odds and win probability were built. Whether ESPN updates sportsbook lines during a game, and whether its scoreboard carries the last play's win probability, could not be observed. Gridiron calls in-game lines "the latest lines reported", and without a scoreboard value a card shows win probability once the game's detail has loaded.
- Division II and III add many games and are polled only when selected.
- A scoreboard that returns its 500-game limit is flagged, because games may be missing.

Known provider quirks the normalizer handles, each covered by tests against captured data:

- A stoppage (two-minute warning) sometimes reports a 0-0 score. It is ignored.
- Timeouts and period ends carry a team id that is not possession.
- Plays can arrive out of order or duplicated. They are ordered by wall clock and deduplicated by id.
- The current drive also appears in the list of previous drives.
- Leftover clocks appear at period breaks, and college overtime reports a "0:00" clock.
- A sportsbook with no moneyline reports it as "OFF"; Gridiron shows the spread and total alone.

## How updates work

The server's engine owns the polling. Browsers declare what they need (day, divisions, focused, visible and monitored games), and the engine aggregates that interest:

| What | Interval |
| --- | --- |
| Scoreboard, day with live games | 25 s |
| Scoreboard, day with nothing live | 5 min |
| Scoreboard, past day | 30 min |
| Game you have open (focus) | 12 s |
| Game on screen | 25 s |
| Other live game (for alerts) | 60 s |
| Scheduled game detail | 10 min |
| Final game detail | 20 min |
| Kalshi prices, while a followed game is live or within an hour of kickoff | 15 s |
| Kalshi prices, otherwise | 5 min |
| Kalshi price history of a followed game, while live | 45 s |
| Kalshi price history of a followed game, before kickoff | 5 min |

- Each league-day and each game has one task that never overlaps itself, with jitter.
- The fetcher allows 6 concurrent requests, 150 per minute across all users, and a 9-second timeout. Kalshi has its own fetcher: 2 concurrent requests and 60 per minute.
- 429 and 5xx responses retry with backoff and honour `Retry-After`. In-flight requests are deduplicated.
- Changes are detected by fingerprinting normalized data. Browsers receive deltas over server-sent events, with version checks and a full resync when a delta cannot apply. Win probability, lines and market prices ride the same deltas, and a price read that changes nothing sends nothing.
- A provider that pushes updates (Sportradar on production access) goes through the same merge and versioning, and polling continues underneath to reconcile anything a push missed.
- The client falls back to polling if streams fail, and reconnects with backoff. Anything that arrives after a gap is marked as a late update.
- Freshness is shown as connected, reconnecting, delayed, provider unavailable or offline, with the last successful fetch and the last change per league.
- Team pages are shared by every viewer and kept for 60 seconds while the team has a live game, 10 minutes otherwise, and 20 seconds after a failure.
- **Clocks are never counted down locally.** A clock shows what the provider last reported.

**Spoiler delay** (Off, 15, 30 or 60 seconds, or custom up to 300) holds one presentation timeline. Scores, fields, drives, plays, win probability, odds, alerts, Watch next and sorting all read the same delayed state, so nothing leaks early. While the buffer fills, the page says "Buffering" and when it will be ready.

## Odds and win probability

Every figure comes from a source that reported it. Gridiron never calculates a chance, and never mixes sources without naming them.

- **Win probability** is ESPN's model after each reported play: the home team's chance, and a tie where one is possible. Cards and the pop-out show it as a meter with the leader's chance and, for a few seconds, the swing the latest play made. The game page adds the value at the inspected play and a play-by-play chart in Game flow.
- **Matchup predictor.** Before kickoff, cards and the game page show ESPN's pre-game matchup predictor, drawn with a hatched meter.
- **Sportsbook lines** are the first-priority sportsbook ESPN reports (DraftKings, for every game captured in September 2026): spread, moneyline and total, each with its opening value. Before kickoff they are the current lines, during a game the latest lines reported, and after it the closing lines, with how the final score compared.
- **Kalshi prices.** Each team's contract to win, and the spread and total contracts nearest the sportsbook's lines. A price of 55% means the contract trades around 55 cents: the middle of the best bid and ask while they are at most 5 cents apart, otherwise the last trade. Prices that have not refreshed for 90 seconds are marked as possibly out of date.
- **Price history.** Game flow's win probability view draws Kalshi's price for the home team to win as a dashed line beside ESPN's model. Each price sits between the plays around it by time, so a price that moved during a timeout sits between those plays, and the line stops at the latest play shown. The odds panel adds a sparkline of the same contract and how far it has moved: over the week before kickoff, or from an hour before kickoff once the game starts.
- **Why these sources.** Both can be read with no account, key or sign-up, and DraftKings lines arrive through ESPN. Polymarket's public NFL series returned no game events when checked on 14 September 2026. Reading FanDuel, BetMGM, Stake or Robinhood directly would mean scraping their sites or paying for an odds service, so Gridiron does not.
- **Formats.** American (−130), decimal (1.77) or chance (57%), chosen in Display settings or on the game page panel. Chance shows what odds imply, with the sportsbook's margin still in.
- **Settings.** Display settings can turn odds and win probability off everywhere.
- **Replays** include the captured closing lines, ESPN's win probability cut at the replay clock and, for the NFL Week 1 replay, Kalshi's prices captured minute by minute and cut the same way. Replays never read Kalshi live.

Odds and prices are shown for information only, not as betting advice. 21+. Gambling problem? Call 1-800-GAMBLER.

## Reading the field: schematic conventions

- The real stadium direction is not reported. By convention **the away team defends the left end zone** and the home team the right. Every field says so.
- Field position uses reported values only, in this order:
  1. The provider's field-position label ("BUF 35")
  2. Its yard line, measured from the home goal line
  3. Its distance to the end zone
  The spot's source is shown on the game page. If none is reported, the field says **"Ball spot unavailable"**. The ball is never guessed to midfield.
- The ball sits on the centre axis unless the data carries a lateral position. No live provider reports one; the game page's field note says which applies.
- Blue marks the line of scrimmage and amber the line to gain. On goal to go, the goal line is highlighted instead; no marker is drawn in the end zone.
- The red zone is tinted when the offense is inside the opponent 20. An arrow shows the attacking direction.
- Movement between two reported spots uses a schematic shape from the reported play type:
  - Runs sweep and passes arc. Punts, kickoffs and field goals fly high.
  - Incompletions go out and come back. Sacks drop back.
  Routes, formations, landing points and tackle locations are not reported and are never drawn.
- Drive strips and charts draw only reported spots. A play without one keeps its row and says "Spot not reported".
- The field label names the play and its reported yardage, such as "Rush +7" or "Sack −8". "First down" is added only when the reported downs show a new set of downs, and the line to gain then sweeps out once.
- Emphasis follows the reported event: touchdown (the end zone lights in the scoring team's color), field goal, safety, turnover, penalty flag and review. In the holographic style, sheets of light rise at the line of scrimmage and the line to gain, a beam tracks the ball, and a touchdown raises a column of light and sparks in the scoring team's color. Timing bands:
  - 150 to 250 ms for settles
  - 300 to 500 ms for short moves
  - 500 to 1000 ms for flights and scores
- A burst of delayed plays settles without animating each play. A corrected play shows "Play corrected" and never celebrates twice.
- Markings follow the 2026 NFL and NCAA rulebooks:
  - Hash marks: 70 ft 9 in from each sideline in the NFL, 60 ft in college.
  - Numbers: bottoms 12 yd from the sideline in the NFL, tops 9 yd in college.
  - Direction arrows beside the numbers.
  - The NFL try line at the 2.
  - Goal posts: 10 ft crossbar, 18 ft 6 in wide, gold NFL uprights 35 ft above the crossbar.
  - Pylons: 8 in the NFL, 12 in college.
  - Border rules for each league.
  Lines have a minimum width so they stay legible in miniature.
- The game page's stadium is decoration. It says nothing about the real venue, its size or its crowd.

## Replay lab

The replay lab plays **captured ESPN responses** (`fixtures/espn`) through the same normalization, engine, stream, alerts and fields as live data. Replays are labeled on every screen and never mixed into live data.

| Scenario | What it is |
| --- | --- |
| `nfl-week1-sunday` | NFL, Sunday 13 September 2026, 13 games |
| `college-week2-saturday` | College, Saturday 12 September 2026, a sample across FBS, FCS, Division II and III |
| `nfl-overtime` | Giants at Cowboys, 14 September 2025, decided in overtime |
| `college-overtime` | Baylor at SMU, 6 September 2025, double overtime |
| `test-overturned-touchdown` | Synthetic: a touchdown reversed on review |
| `test-delayed-burst` | Synthetic: five plays withheld, then delivered at once |
| `test-missing-spot` | Synthetic: ball spots omitted for several plays |
| `test-provider-outage` | Synthetic: the provider stops answering for two minutes |
| `test-lateral-position` | Synthetic: lateral ball positions estimated from play descriptions, to show how a reported lateral position is drawn |

The five test scenarios are built on real games but contain deliberate edits, and they are labeled "Synthetic".

- Each browser tab gets its own session with play, pause, speed, step, seek and simulated outage controls.
- Start state can be put in the URL: `/?replay=nfl-week1-sunday&at=0.35&speed=30&paused=1`.
- Team pages in a replay read saved team documents (`fixtures/espn/team`). Results after the replay clock are hidden, and so are the record, rank and standing.
- Win probability is cut at the replay clock like the plays. The sportsbook lines were captured after the games, so replays show them as closing lines throughout.
- The NFL Week 1 replay carries Kalshi's prices for its 13 games, captured minute by minute (`fixtures/kalshi`) and cut at the replay clock: each team's contract as of the latest captured minute, and the price history up to the clock. Like live prices, they end with the game. Synthetic scenarios never carry them.
- A watch party guest joins the host's replay session, so everyone sees the same clock.
- Captured data is refreshed with `npm run fixtures`, which needs network access. `npx tsx scripts/augment-fixtures.ts` then adds leaders, attendance, sportsbook lines and win probability to the captured summaries, and `npx tsx scripts/capture-kalshi.ts` captures Kalshi prices for a real replay.

## Alerts

Moments:

- Touchdown, field goal, safety, turnover and big play
- Red-zone entry, a fourth-down attempt (converted or stopped), and fourth-down situations
- Lead change, tie, close game late, overtime and final
- Favorite team kickoff, review or challenge, and "Score changed"

Reliability rules, all unit-tested:

- **Arrival is a baseline.** Games in progress when you arrive, and play-by-play seen for the first time, are never announced as new.
- **Ids come from the real moment,** such as a play id or a score transition. Reconnects and repeated polls cannot duplicate them.
- **Corrections update or withdraw.** A reversed touchdown is marked "Withdrawn by a correction"; it is never celebrated again.
- **Types come from reported plays.** A score that rises by six is not a touchdown by itself. An unexplained change waits up to 90 seconds for its scoring play, then says "Score changed".
- **Transitions need a known before state.** Red-zone entry needs outside-to-inside. A lead change needs the leader to switch sides. Fourth-down situations are deduplicated by possession, spot and period. Close-late fires once per period.
- **Late and grouped.** Moments from a gap or a burst of delayed plays are marked "Late update". Moments that arrive together are grouped into one toast.
- **Timeline jumps rebaseline.** A replay seek, a delay change or a source change starts a fresh baseline.

Settings:

- Scope: all games, pinned and focus, or favorites. Each kind can be turned on or off.
- Thresholds: big-play yards, close margin and the late window.
- Delivery: quiet mode, per-game mute, and snooze.
- **Sound is off by default** and is enabled only by your click, which plays a test chime.
- **Browser notifications** ask for permission only when you turn them on.
- Screen reader announcements are polite, one at a time, for the kinds you choose.

### Push alerts

Push alerts reach a device even while Gridiron is closed. They need the persistent server and a production build, which installs the service worker.

- Turn them on in Alert settings. The browser asks for permission, and the subscription follows your favorite teams (up to 32) and the kinds of moments you choose.
- The server runs the same alert rules on those teams' live games and sends each moment as an encrypted Web Push message (RFC 8291) signed with its VAPID keys (RFC 8292).
- A correction replaces the notification it corrects. **Send a test** checks the device, at most once every 30 seconds.
- Messages go only to known push services: Google (FCM), Mozilla, Apple and Windows. Each subscription receives at most 12 alerts in 5 minutes, and an alert that cannot be delivered within an hour expires.
- A subscription the push service reports as gone is removed at once, and one that keeps failing is removed after repeated attempts.
- Subscribing is limited to 30 changes per address in 10 minutes, and requests from other sites are refused.
- Replay lab sessions never send push alerts.

## Watch parties

Watch parties need the persistent server.

- Start one from the header or the command palette, then share its link or QR code.
- While the party runs, the host's tab sends its view as it changes: the page, focused games, the data source (live, or a replay session and so its clock), an inspected play, the spoiler delay, the day and the league. Nothing personal is shared, and the host's token stays in the host's tab.
- Guests follow that view. Moving to another page means exploring on their own, and **Follow the host** brings them back. Leaving restores their own settings.
- When the host ends the party, or the server restarts, guests are told the party has ended.
- Limits: 200 parties at once, 50 people in each, 8 host updates a second, and 12 new parties per address in 10 minutes. A party nobody is watching is removed after 6 idle hours.

## Graphics and performance

- **One WebGL canvas** draws every field. React Three Fiber and drei `View` scissor each field into its card's rectangle.
- **Demand rendering.** Frames render only for data changes, scrolling, layout shifts and running animations. The game page's stadium is static, so it adds no frames.
- **Shared resources.** Geometry and materials are shared, and goal posts and pylons are merged into single draw calls. The turf texture is drawn once per league. End-zone textures are reference-counted per team.
- **Offscreen suspension.** A field's 3D scene unmounts when its card is far from the viewport.
- **Adaptive resolution** depends on the effects setting, the number of fields and measured frame cost.
- **Atmosphere.** The page background is one small fragment shader in raw WebGL (no three.js): a grid floor, a horizon glow, light beams and dust. It renders at reduced resolution and about 30 frames a second, holds a still frame when effects or motion are reduced, pauses while the tab is hidden, and is left out in 2D mode.
- **Performance modes:**
  - Full: 3D with animation.
  - Reduced: 3D with fades, at lower resolution.
  - 2D: SVG fields drawn from the same markings, and no WebGL at all.
  The device's reduced-motion setting is always respected.
- **Context loss** switches every field to 2D with a notice, retries automatically, and offers Retry 3D.
- **Code splitting.**
  - The app starts with about 410 kB of JavaScript (about 116 kB with Brotli) in eight files the page preloads, and about 110 kB of CSS (about 20 kB with Brotli). Exact figures for each release are in [docs/VERIFICATION.md](docs/VERIFICATION.md).
  - three.js, React Three Fiber and the field renderer (954 kB, 211 kB with Brotli) are fetched once the app has started, while the page renders. They are never loaded in 2D mode.
  - The game page (64 kB, 17 kB with Brotli), the settings dialogs (27 kB) and the command palette (8 kB) load on first use. Their code is fetched once the page is idle, so they open at once, unless the browser asks to save data.
  - Team pages (13 kB) and the watch party dialog with its QR code encoder (12 kB) load the first time they are used.
  - If a chunk cannot load, for example after a new deploy, the page reloads once. After that, 3D fields fall back to 2D, a game or team page shows its recovery panel, and a dialog or the command palette closes and says it could not load.
- **Compression.** `npm run build` writes Brotli and gzip copies of text assets. The Node server sends the best copy the browser accepts, and gzips JSON of 1.4 kB or more.
- **Service worker** (production builds only). It keeps the app shell and hashed build files for quick starts, and shows push alerts. It never caches `/api`.
- Text never lives in the canvas. Scores, clocks, situations, odds and messages are DOM, above the field.

Measured numbers are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Licensed providers

The UI and engine speak only the normalized model in `shared/model.ts`, and a provider implements `SportsProvider` in `server/providers/`.

`server/providers/sportradar/` is an adapter for Sportradar's NFL and NCAA Football v7 APIs, chosen with `GRIDIRON_PROVIDER=sportradar` and keys in server environment variables. It was written from Sportradar's public documentation and tested only against fictional fixtures; it has not been run against the real API. [docs/PROVIDERS.md](docs/PROVIDERS.md) covers the interface, the adapter and its limits, prediction market prices, and the rules (keys server-side, unknown values as null, reported chances only, no fallback to other data). No paid credentials are required or included.

## Accessibility and privacy

Accessibility:

- Landmarks and a skip link.
- Modal dialogs trap focus, close with Escape and return focus.
- The command palette uses combobox and listbox semantics.
- Every field has a text summary in its card link, including the win probability of a live game.
- Game flow points, win probability swings and drive chart rows are buttons that describe each score or play, including a play whose spot was not reported. A swing also names Kalshi's price at that play when it is known.
- The game page's win probability meter has a text alternative, and its odds are real tables with headers.
- Cards can be reached with `J`, `K` and the arrow keys.
- Moments are announced through a polite live region. The Director announces each game change the same way.
- Colours meet contrast in both themes, and reduced motion is respected.
- An axe-core audit (WCAG 2.1 A and AA) runs in the end-to-end suite on the slate in both themes, a game page, a team page, the alert, watch party and display dialogs, and the not-found page. Serious and critical findings fail it.

Privacy:

- Preferences live only in this browser's local storage: favorites, pins, layout, density, theme, odds settings, alert rules, mutes, sound, effects, delay, filters, boards and the Director settings. For While you were away, it also keeps a snapshot of the last reported scores seen on this device.
- ESPN and Kalshi are read by the Gridiron server. Your browser never contacts them for data, and nothing about you is sent to them.
- With push alerts on, the server that sends them keeps this browser's push endpoint and its encryption keys, the chosen teams and alert kinds, and delivery bookkeeping, in its cache directory, readable by its owner only. Nothing in it identifies a person. Turning push alerts off deletes it.
- A watch party holds only the shared view, in the server's memory.
- There are no accounts, analytics or tracking.

## Project layout

```
shared/      normalized model, field geometry and markings, formatting, alerts, Watch next,
             Director, While you were away, game flow, drive tracks, odds arithmetic, win
             probability, market price history, team pages, push payloads, QR codes, delay
             buffer, replay frames, play animation planning, boards, version
server/      engine (polling, pushed updates, market prices, interest, deltas), fetcher, HTTP and
             SSE, config, rate limits, providers/espn (normalization, lines and win probability,
             coverage discovery, team documents), providers/sportradar, markets/ (Kalshi), team
             pages, watch parties, push/ (Web Push, VAPID keys, subscriptions), replay lab
src/         React client: app shell and router, state (Zustand), data transport, components,
             views, field/ (3D and SVG renderers, stadium), fx/ (atmosphere, boot), styles
api/         Vercel serverless adapter
public/      icons, manifest, service worker, share image, robots.txt
fixtures/    captured ESPN responses and team documents, a scheduled game's odds, Kalshi prices
             captured for the NFL Week 1 replay, and fictional Sportradar responses
tests/       Vitest unit and integration tests
e2e/         Playwright journeys (replay mode), accessibility audit, screenshots, performance
scripts/     dev runner, server bundler, asset compression, icon rendering, fixture capture and
             augmentation, Kalshi capture, smoke test, serverless check, e2e server
docs/        providers, verification report, completion checklist, screenshots
```

## Testing

```bash
npm test            # unit and integration tests (Vitest)
npm run test:e2e    # Playwright journeys and the accessibility audit, against the production build in replay mode
npm run smoke       # checks a running server: health, slate, detail, stream, replay (GRIDIRON_URL to target a deployment)
npm run check:serverless   # loads the Vercel function as plain Node ES modules, the way Vercel runs it
```

- The end-to-end suite runs every journey in Chrome, and the journeys tagged `@cross` in Firefox and WebKit. Install those two browsers once with `npx playwright install firefox webkit`.
- It uses the installed Chrome by default. `PLAYWRIGHT_CHANNEL=bundled` uses Playwright's own Chromium, as CI does.
- Choose browsers with `--project`, for example `npx playwright test --project=desktop-chrome --project=webkit`.
- `GRIDIRON_CAPTURE=1` writes the design screenshots in `docs/screenshots`, and `GRIDIRON_PERF=1` records `docs/perf.json` and `docs/perf-game.json`.
- Kalshi is never called in tests. Its unit tests use a stand-in with Kalshi's field names and made-up prices, and the replay tests read the prices captured in `fixtures/kalshi`.

---

An independent product by [John Jayasankar](https://johnjayasankar.com/), part of [Labs](https://labs.johnjayasankar.com/). Not affiliated with the NFL, the NCAA, ESPN, DraftKings, Kalshi or Sportradar.
