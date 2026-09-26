# Gridiron

**Every game. Every drive. One view.**

Gridiron is a live NFL and college football command center. Every game gets its own interactive 3D field showing the reported ball spot, possession, line of scrimmage, line to gain and the latest play's movement, next to the score, the situation, live win probability and odds, the current drive and a moments feed. Team pages, watch parties and push alerts for favorite teams are built in.

An independent product by [John Jayasankar](https://johnjayasankar.com/), part of [Labs](https://labs.johnjayasankar.com/).

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

---

## Contents

- [What is in it](#what-is-in-it)
- [The tape](#the-tape)
- [Run it](#run-it)
- [Deploy](#deploy)
- [Data sources and coverage limits](#data-sources-and-coverage-limits)
- [How updates work](#how-updates-work)
- [Odds and win probability](#odds-and-win-probability)
- [The sky over the field](#the-sky-over-the-field)
- [The arena itself](#the-arena-itself)
- [Reading the field: schematic conventions](#reading-the-field-schematic-conventions)
- [Replay lab](#replay-lab)
- [Alerts](#alerts)
- [Watch parties](#watch-parties)
- [Graphics and performance](#graphics-and-performance)
- [Licensed providers](#licensed-providers)
- [Accessibility and privacy](#accessibility-and-privacy)
- [Project layout](#project-layout)
- [The shared boundary](#the-shared-boundary)
- [Testing](#testing)
- [License](#license)

Beside this file, in `docs/`:

- **[CASE_STUDY.md](docs/CASE_STUDY.md)** is the short version: the four decisions that define the product, each with what it cost and what it bought. Start here if you are deciding whether to read the rest.
- [DEPLOYMENT_DECISION.md](docs/DEPLOYMENT_DECISION.md) works out where this should be deployed, and why the answer is a persistent server.
- [PROPOSALS.md](docs/PROPOSALS.md) argues whether there should ever be a second sport, counting what is actually football-shaped before arguing about it.
- [TAPE_PERSISTENCE.md](docs/TAPE_PERSISTENCE.md) designs where the tape's recording should live, before any of it is built.
- [PROVIDERS.md](docs/PROVIDERS.md), [VERIFICATION.md](docs/VERIFICATION.md) and [CHECKLIST.md](docs/CHECKLIST.md) are the provider interface, the verification report and the completion checklist.

## What is in it

- **Slate.** A responsive grid with live games first, then upcoming and final. It shows live and monitored counts, notable situations (overtime, one-score games late, red zone, fourth down) and a Watch next strip with the reasons for each pick.
- **Win probability and odds on every card.** A live card shows ESPN's win probability after the latest play as a meter in team colors, with the swing that play made, plus the sportsbook spread and total and the Kalshi price for the market favorite. Before kickoff, the meter shows ESPN's matchup predictor. See [Odds and win probability](#odds-and-win-probability).
- **Drive tracker.** Every live card carries a strip of the current drive: where it started, where each reported play ended, the line to gain and the ball, with plays, yards and time.
- **While you were away.** Come back after 4 minutes or more, or reopen Gridiron later the same day, and the slate opens with what was reported in the meantime. It lists scores, turnovers, kickoffs and finals for each game, and each play links to its view on the field. It is built only from snapshots of reported data.
- **Focus.** One, two or four games at a large size. Each slot can be replaced, moved or cleared.
- **Wall.** Full screen, 4, 9 or 16 games, compact or comfortable, with an exit control and Escape.
- **The tape.** The whole day on one clock: every game a lane, the reported win probability drawn across the afternoon as the distance from an even chance. A close game is a thin line down the middle, a decided one a thick band, and a game that turned crosses the middle at the moment it turned. Pointing anywhere reads every game at that moment at once, and clicking opens that game at the play that was live then. Every card carries the same ribbon at card size, so the slate shows the shape behind the score. See [The tape](#the-tape).
- **Director mode** in Focus and on the wall. The first Focus slot, or a large wall tile, follows the most important live situation and names the reason.
  - It holds a game for at least 45 seconds and cuts in for a touchdown, turnover, safety, lead change or overtime elsewhere.
  - **Stay** holds the current game and **Skip** sets it aside for 3 minutes.
  - When nothing is live, it shows the next kickoff.
- **Game page** at `/game/<id>`, shareable:
  - A large 3D field with isometric, broadcast and top-down cameras, reset, and a restrained orbit and zoom, inside a bowl the size of the real stadium.
  - **A scorebug on the field**, the way a broadcast puts one there: both sides in their own colours, the score, the clock, whoever has the ball as a lit row, what they face in the provider's own words, timeouts as three pips a side, and the red zone. It makes the field self-contained on the wall, in a pop-out, or scrolled past the scoreboard. With holographic fields and Full effects, the camera flies in over a decorative stadium.
  - Scoreboard and situation, with previous and next game buttons. The `[` and `]` keys and a swipe across the scoreboard also move between games.
  - An odds and win probability panel, **as of whatever play you are looking at**. The win probability is the provider's figure after that play, with the change it made. The exchange's price is the last one recorded at or before that play's wall-clock time, with the change since the play before it, and the trend beside it stops there too, so the whole block is one moment rather than two. Nothing is interpolated: a price recorded after the play is never used, because it was not known then, and a play the provider gave no wall-clock time for gets no price at all.
  - The sportsbook rewinds too, from Gridiron's own record. The provider reports an opening line and a latest one with no times attached, so Gridiron writes down every line it is told and when it was told it, and shows the one that stood at the play with what it had been before: "As reported 5 min before this play". Where the record has nothing to say about that moment it says which kind of nothing it is, **"No line recorded at this play"** for a game it was watching and **"Opening and closing lines, not play by play"** for a game no record was kept for, rather than letting a closing line be read as the line at that moment.
  - A drive chart that draws every reported play of the current drive as an arrow across the field. Selecting a play inspects it.
  - Drive replay: play, pause, step, scrub, speed, scoring jumps, current drive and back to live.
  - **The reel: every scoring play in order, drawn on the field.** Landing on a play is deliberately a burst that draws no movement, which is right for a jump and wrong here, where the jump is the thing being watched, so the reel draws each score with its flight, its trail, its mark on the ground and the stands answering it. It runs the whole game's scores from the first, holds each one for a beat that scales with the replay speed, and hands the game back to live when it reaches the end. Anything done by hand ends it, because the viewer has taken the game back off it. `R`, the button beside the scoring jumps, or the command palette.
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

## The tape

Every other view answers "what is happening now". A football Sunday is a dozen
games running at once, and the thing a Sunday is actually about is how they sit
against each other in time: which game has been worth watching, where the day's
swings landed, and which games are arriving at their endgames together. A grid
of cards cannot show any of that, because a grid has no time in it.

So Gridiron keeps a recording. Every time the presented world changes, each
game's reported score and win probability are written down with the moment they
were true. Nothing is fetched for it and nothing is sent anywhere: it is the
same basis as "While you were away", a note of what the provider reported, kept
on this device.

**Reading a lane.** The band is the home team's reported chance to win, drawn
from the middle out rather than from the bottom up. Drawn from the bottom, a
nine in ten chance and a certainty look the same; from the middle, the thickness
*is* the margin. The centre line is an even chance, so a crossing is a game
changing hands. Upright marks are score changes, and the faint ones behind them
are quarters. Where the provider reported no win probability the ribbon stops
rather than joining across the gap, because a line between two known points is a
claim about the time between them.

**Under the band runs the pressure.** A second track along the bottom of each
lane shows where a team was inside the twenty, in that team's colour. It turns
the lane from "who was winning" into "who was winning, and who was knocking":
red zone stacked up before a score mark is a drive that finished, and a long bar
with no mark after it is one that did not. The recorder already keeps it, so it
is drawn in the same pass and costs nothing.

**Reading the day.** Above the lanes, three measurements: the game whose
reported chance has moved most, the largest single swing anywhere on the card
and where it landed, and the game that has changed hands most often. Each names
the measurement rather than a verdict. "Most movement" is not "best game", and
calling it that would be putting a rating on somebody else's model.

**Games finishing together** is called out when two or more live games are
within one score in the last five minutes of regulation or beyond. It is the one
state a Sunday turns on that no single card can report, because each card only
speaks for itself.

**Pointing at the tape** puts one line across every lane and reads all of them
at that moment: the score each game was at, the clock it was on, where its
chance stood. It is the question "what was happening at ten to four" answered
for the whole card at once. The arrow keys do the same thing: the lanes take
focus, left and right step through the afternoon, shift takes a coarser step,
Home and End go to its ends and Escape hands the lanes back to the live game.

**Clicking a moment opens it.** A point on a lane is a play on the field, so the
band opens that game at the play that was live at the moment under the pointer,
not at the game's latest state. The game page holds there while the live game
moves on and offers Back to live, exactly as stepping through a drive does. The
recording keeps the play each reading followed, so this is the same reported
play rather than a guess from the clock. Where the provider reported no play for
that moment, the lane opens the game plainly rather than inventing one. The
day's biggest swing in the summary above the lanes opens its own play the same
way, because a swing was one play and that is the play worth seeing.

**Movement** is the sum of every change the provider's win probability made,
added up over the day, in probability points. It is a measurement of what was
reported, not a rating: a game with one enormous swing and a game with forty
small ones can arrive at the same number. A game whose provider reported no win
probability shows none rather than a zero.

**Nothing in a lane moves.** A lane's drawing is a function of its own data and
the width of its column, and of nothing else: the clock and the pointer are not
part of it. They used to be, and it was the wrong shape, because a dot moving
four pixels rebuilt every ribbon, quarter, score and red zone on the page sixty
times a second. The live edge and the scrub dot are two absolutely placed
elements moved by a transform, which the compositor does on its own. Scrubbing
right across a stopped card rebuilds **nothing at all**, which `e2e/tape.spec.ts`
asserts by tagging every node in every lane and counting what came back new.

The rest is static: corner brackets, the trailing rule, the glow on a numeral
and the gradient in a band are painted once when the element is rasterised. The
only motion is a one shot entrance on transform and opacity, stepped by lane and
capped at twelve steps so a Saturday of sixty games never leaves the last one
waiting a second and a half to appear. It is off under Reduced and 2D effects
and under the device's reduced-motion setting.

The tape is drawn in DOM and SVG, so it works identically in Full, Reduced and
2D effects modes and needs no WebGL at all. It survives a reload within the same
tab. A replay records on the replay's own clock, so a Sunday played back at
thirty times speed still draws the shape of a Sunday.

`4` opens it, or Tape in the layout control, or "Open the tape" in the command
palette. It lives at `/tape`.

**The day's biggest swing is in the command palette**, from any screen, and
opens the play it was. It names the measurement and the game rather than
calling it the play of the day, and it is absent rather than empty when there is
no recording yet, no win probability anywhere, or no reported play for it.

### The pulse on a card

The recording is not only worth a view of its own. The meter on a live card says
who is ahead right now; it cannot say whether that was always true. "Ravens 17,
Colts 14, Q3" is the same card whether it has been a three point game all
afternoon or a rout that has just come back, and those are not the same game to
decide to watch.

So every card carries its own lane, at card size, under the odds: the same
ribbon from the same recording, drawn across that game's own span rather than
the day's. Thickness is margin, a crossing is the moment it turned, and a gap is
a stretch the provider reported nothing for. It is the same drawing code as the
tape, so a card and its lane can never disagree about what the day did, which
`e2e/tape.spec.ts` asserts by reading the movement off a lane and then off that
game's card.

It draws nothing at all until there is something to draw: no empty box, no flat
line at an even chance, no placeholder. A game the provider reported no win
probability for simply has no pulse. It follows the odds preference, because it
is a reading of win probability and turning odds off has to take every drawing
of them. Colour comes from the two variables the card already sets for its own
team light, so it costs no colour work and follows a theme change with the card.

Like a lane, nothing in it moves: it takes a game id and nothing else, so the
clock cannot reach it. At the recorder's cap of 900 readings, building the shape
takes 0.7 ms and laying out sixty of them takes 1.6 ms, measured in the browser
on a full replay.

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
| `GRIDIRON_FETCH_BUDGET` | `150` | Provider requests per minute. Counted per process: one persistent server means one budget, and see the note below for what that means on a serverless host |
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

**The fetch budget is per process.** `GRIDIRON_FETCH_CONCURRENCY` and `GRIDIRON_FETCH_BUDGET` are enforced by a counter inside one running server, which is what the persistent deployment is: one process, one budget, one ceiling on how hard this asks the provider. On the Vercel deployment there is no single process. Each warm instance carries its own counter, so the real ceiling is 150 a minute multiplied by however many instances are warm, which nothing here knows or controls. The numbers above are honest for the persistent server and are an upper bound per instance, not a guarantee, on the serverless one. That is one of the reasons [docs/DEPLOYMENT_DECISION.md](docs/DEPLOYMENT_DECISION.md) recommends the persistent server; the provider is undocumented and has refused this deployment once already.

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

Which of these should be the public link is worked through in [docs/DEPLOYMENT_DECISION.md](docs/DEPLOYMENT_DECISION.md), with what each option costs and why. The short answer is the persistent server, and the deciding argument is the fetch budget rather than the features.

### Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: typecheck, unit tests and the production build, then the end-to-end suite in Chromium, Firefox and WebKit.

## Data sources and coverage limits

Gridiron's default provider is **ESPN's public site API**. The endpoints are undocumented, unofficial and unlicensed:

- Scoreboard: `site.api.espn.com/apis/site/v2/sports/football/{nfl|college-football}/scoreboard?dates=YYYYMMDD&limit=500[&groups=ID]`. Its competitions carry sportsbook `odds`.
- Game summary: `…/summary?event=ID`. It carries sportsbook lines (`pickcenter`), win probability after each play (`winprobability`) and, before kickoff, the matchup predictor (`predictor`).
- Team and season schedule, for team pages: `…/teams/ID` and `…/teams/ID/schedule?season=YYYY&seasontype=1|2|3`
- College group metadata: `sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/{year}/types/{type}/groups`, with its children and group documents
- Live sportsbook line, for a followed game: `sports.core.api.espn.com/v2/sports/football/leagues/{league}/events/ID/competitions/ID/odds`. Its `current` is the line the book is offering; the scoreboard and the summary carry only an opening and a closing one. Its sibling `…/odds/{provider}/history/0/movement` exists and has always returned an empty page, so there is no line history to read.
- Venue roof and playing surface, once per venue: `sports.core.api.espn.com/v2/sports/football/leagues/{league}/venues/ID`, which reports `indoor` and `grass`. The weather at a venue is on the scoreboard event itself.

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
  - **The live line comes from ESPN's core API, which is the only place it appears.** The scoreboard and the game summary report an opening line and a closing one, and while a game is running there is no closing line yet, so those two payloads have nothing to say during the ninety minutes the line moves most. The core API's odds document carries `open`, `current` and `close`, and `current` is the live one: on a finished game it equals the close and differs from the open, so it tracked the game and stopped. A followed game reads it every twelve seconds, alongside the summary rather than after it. It is never read for a whole scoreboard, because a college Saturday is sixty games and a line nobody is looking at does not need reading every twelve seconds.
- **Kalshi prices.** Each team's contract to win, and the spread and total contracts nearest the sportsbook's lines. A price of 55% means the contract trades around 55 cents: the middle of the best bid and ask while they are at most 5 cents apart, otherwise the last trade. Prices that have not refreshed for 90 seconds are marked as possibly out of date.
- **Line history.** Whenever the live line differs from the one Gridiron last wrote down, that is a new point stamped with when it was seen: both sides of the spread, the total and the moneyline, up to 240 points a game. It is a record of what was reported and when, never an estimate of what a book was offering at a moment nobody looked, and the game page rewinds it to the play being inspected by the same rule the exchange's price uses.
  - **There is no historical source to fall back on.** The provider has no endpoint that says what a line was at a past moment: its own line-movement collection exists and is always empty, and its odds documents carry no timestamp of any kind. A book's line can only be known for a game something was watching at the time, which is what makes the recording the whole mechanism rather than a cache.
  - **How the line moved is drawn beside it**, as a step line with a mark for every reading the book posted, because a book posts a line and it stands until the book posts another. It appears only where the record has movement in it: a game Gridiron was not watching gets no trend rather than a flat one. A figure lights for a moment when the book moves it.
  - **It needs something watching continuously**, which is the persistent Node server. On the serverless deployment the recording accumulates only for as long as one warm function lives and is fragmented across instances, so a game page there says it has no line recorded rather than presenting a gap as a reading. Watch parties, push alerts and the replay lab are bounded the same way and for the same reason.
  - **A replay rewinds a recording made while that game ran.** `npx tsx scripts/capture-lines.ts --league nfl --live` records games in progress into `fixtures/lines/`, using the same rule the running server uses, and a replay of a game it watched shows the line that stood at the replay clock and rewinds it to any play. A scenario nothing was recording for has no line and says so; the captured replays that ship with Gridiron predate the recording, so they say so. Nothing is recorded inside a replay: a replay runs on the original game's clock, so a reading taken today would stand after every play in it and describe none.
- **Price history.** Game flow's win probability view draws Kalshi's price for the home team to win as a dashed line beside ESPN's model. Each price sits between the plays around it by time, so a price that moved during a timeout sits between those plays, and the line stops at the latest play shown. The odds panel adds a sparkline of the same contract and how far it has moved: over the week before kickoff, or from an hour before kickoff once the game starts.
- **Why these sources.** Both can be read with no account, key or sign-up, and DraftKings lines arrive through ESPN. Polymarket's public NFL series returned no game events when checked on 14 September 2026. Reading FanDuel, BetMGM, Stake or Robinhood directly would mean scraping their sites or paying for an odds service, so Gridiron does not.
- **Formats.** American (−130), decimal (1.77) or chance (57%), chosen in Display settings or on the game page panel. Chance shows what odds imply, with the sportsbook's margin still in.
- **Settings.** Display settings can turn odds and win probability off everywhere.
- **Replays** include the captured closing lines, ESPN's win probability cut at the replay clock and, for the NFL Week 1 replay, Kalshi's prices captured minute by minute and cut the same way. Replays never read Kalshi live.

Odds and prices are shown for information only, not as betting advice. 21+. Gambling problem? Call 1-800-GAMBLER.

## The sky over the field

Every field used to be lit the same way, which made a night game in the snow and a one o'clock game in the sun the same picture with different end zones. ESPN reports the weather at the venue and whether the venue has a roof, so the field says so. Nothing here is a forecast, a guess or a mood.

- **The light is the reported condition.** The sun is scaled and tinted by it, the sky itself fills more of the shadows as the weather closes in (an overcast day is one big soft light), the far end of the field is lost in the air in fog, and a roof is its own even light from straight above with no weather at all.
- **Night comes from the provider, not from a clock.** ESPN's condition ids carry their own sense of dark: 33 to 44 are the night forms of 1 to 14. That is the only honest signal, because a venue's local time zone is not reported and a kickoff time in UTC does not say. It works because the reported condition is the forecast at kickoff: a game starting at 8:15 in the evening is reported with a night form hours beforehand.
- **Rain and snow fall on the game page**, where the provider reported rain, a thunderstorm, snow or ice, and nowhere else. One draw over the field, moved entirely in a vertex shader: each drop walks down its own column at its own speed and wraps back to the top, so a frame writes one uniform and nothing is rebuilt while it falls. Rain is a streak, snow drifts sideways as it comes down. Cards never run their own weather; thirteen of them would be thirteen of these, for drops a pixel across. A card's turf is still lit by its own game's sky, which costs one colour, so a Sunday of thirteen cards shows the snowy games and the sunny ones apart at a glance.
- **A grass field is mown and a synthetic one is not.** Mowing stripes are made by a mower laying the blades one way and then the other, and an artificial surface has no blades to lay. ESPN reports which a venue has on the venue's own document, read once per venue and then remembered: a synthetic field is one flat weave with a seam every five yards where its rolls meet, and a grass field keeps its stripes.
- **The field says what it is lit by**, in ESPN's own words and its own temperature, beside the schematic note. Where nothing was reported the field is lit exactly as it was before there was a sky, and nothing is appended.
- **A venue with a roof is given one.** Whether a venue is indoors is reported, and a roofed one gets a deck over the stands with an opening above the field, ribbed from the corners in, and a membrane the game shows through. It is not a lid: the cameras look down from above the bowl, and a lid would hide the subject. Like everything else on this field it is schematic. ESPN reports that the venue has a roof, not which roof.
- **Where to see one.** No captured replay carries weather or a roof, because both live on the live scoreboard and neither was captured with those games. The `test-weather` scenario puts snow after dark on a grass field and `test-indoors` puts a roof on an open air venue, both at a real game that had neither, and both say so in their label, their description and the replay bar.

## The arena itself

Every field Gridiron draws is a schematic on purpose: the real orientation of a stadium is not reported and neither is its shape, so the field says what it knows and nothing more. That leaves one honest way to show the real place, which is the real picture of it.

- **The game info tab carries the venue's own photograph**, the inside of the bowl where ESPN has one, with the venue and its city under it. Twenty nine of thirty two venues checked across an NFL slate and a college Saturday had one, and every one of those had an interior shot.
- **Only addresses ESPN lists are used.** Guessing a path is not the same as being told where the picture is, and a guessed path here answers: the same venue id under the college prefix returns a different picture than under the NFL one. A venue ESPN publishes no picture for shows none.
- **It loads lazily, behind the tab.** ESPN serves these at full size and ignores any request to resize, so they are one to three megabytes. The space is held from the reported dimensions so the tab never jumps when one lands.
- **The description is written here**, because ESPN ships an empty alt for every one of them. It says what the picture is known to be, which is the venue and whether it was taken inside the bowl, and never what is in it.
- **The surface, the roof and the reported weather are stated on the same tab**, since all three change how the field is drawn.
- **The bowl is the size of the real stadium.** ESPN reports no capacity anywhere, so it comes from a checked-in table of 276 venues generated from Wikidata by `npx tsx scripts/capture-venues.ts`. Every row carries the Wikidata id it came from, so any of them can be checked by hand, and a match is only taken when it is unarguable: the venue is in the United States, ESPN's city appears in the entry's administrative chain, and exactly one entry survives both. Nothing is queried at runtime. A venue with no row is drawn at the size Gridiron has always drawn.
- **What that changes is size, not shape.** Nobody here has the footprint of any stadium, and a bowl drawn to look like one it is not would be an invention nobody could check. A bigger capacity is a bigger, fuller bowl with its floodlights further out; a ground too small for end stands is drawn without them. The field stays schematic and says so.
- **Not reported anywhere, and so not drawn**: a venue's orientation, footprint or roof shape.

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
  - Runs sweep and passes arc. Punts, kickoffs and field goals fly high, and so does an extra point, which the provider reports as a kick on the conversion rather than in the kind of play and which used to slide along the ground like a run.
  - A kick the provider says was blocked never gets away: up off the foot, knocked back down, short and over quickly.
  - **An interception is thrown one way and taken back the other.** It is in the air for the throw and carried for the return, so it spirals out and stops spiralling once it has changed hands. Where it changed hands is not reported, so the turn is drawn just past the further of the throw and the end of the return, which is the one thing that can be said about it: the catch was beyond both, because the ball was thrown forward and then carried back.
  - Incompletions go out and come back. Sacks drop back.
  Routes, formations, landing points and tackle locations are not reported and are never drawn.
- **Each game is played on the home team's field.** The mark at the fifty is the home team's, painted into the turf: their logo where the provider gives one, and their letters in a ring where it does not. It is the same liberty the end zones already take, and it is the one thing that makes a real field that team's field; without it every game was played on the same field with different end zones. On painted turf it is ink at part strength and on the holographic field it is added as light, and it is drawn at a size to suit the field it is on, so a card keeps a quarter of the texture the game page uses.
- **The ball is a football.** It is a circular arc revolved about its long axis, which is the shape a football actually is and is what gives it points at the ends; a scaled sphere has neither and read as a pill. It carries its lace panel, and a college ball carries the two white stripes NCAA rules require while a pro ball carries none, drawn from the same rulebook table as the hash marks. Like every other mark on a schematic field it is well over life size, so that it is still a football on a card.
- **The ball carries itself the way the play says it was thrown.** A pass or a punt spirals about its long axis and its nose follows the arc it is on: up off the hand, level at the top, down into the catch. A ball struck off the ground or a tee, which the reported kind of play names, goes over the top end over end instead and does not spiral at all. A ball being carried is tucked under an arm and does not turn at all, so the ball tells a pass from a run from a kickoff before the description is read. The nose angle is measured from the ball's own last two positions, so it is right for every shape without any of them describing it, and the spin is the speed that reads *as* a spiral at the size the ball is drawn rather than the sixty turns a second a real one makes, which at sixty frames a second would stand still.
- **The ball wears the mark of the team the provider says has it.** Possession is reported, so the field may say it: on the game page the ball carries that team's logo on the two upper flanks either side of the laces, where an elevated camera sees it, and at every size the arrow and the mark under the ball take that team's colour. They ease between colours, so a turnover reads as the field changing hands rather than only as a line of text. When possession is not reported the ball is plain leather and the marks are the field's own colour: it never guesses who has the ball. A logo that will not load cross-origin becomes the team's letters, drawn the same way.
- **The mark under the ball behaves like a shadow**, spreading and softening as the ball climbs. On painted turf it is a shadow and falls away from the light; on the holographic field there is no sun, so it stays under the ball and is light rather than dark, where it is also the only thing marking the ball over a dark surface.
- **The drive is on the field, not only in a chart beside it.** The ground between where the drive began and where the ball is now is shaded in the offense's colour, as a ramp that is faint at the start and strongest at the ball; the play it began at is a dashed line, so it can never be mistaken for the line of scrimmage or the line to gain; and one mark along the near sideline stands for each play the provider gave an end spot for, oldest dimmest, so the spacing of them is the rhythm of the drive. A play the provider gave no spot for has no mark, and the panel beside the field says how many those were. Stepping through the drive replay grows it play by play, because the field and the panel are built from one reading of the drive and that reading is cut at the play being watched.
- **A play draws its own path as it runs.** The arc or the ground ribbon is revealed under the ball rather than appearing once the ball has landed, and it stays until the next play. It brightens toward the ball whichever way the play ran. When the ball arrives, one quick ring marks the spot it stopped, widened by the ground the play covered, so a long gain lands harder than a two yard run.
- **The broadcast camera moves with the play.** It pans along the field while the ball runs, keeping its own height, angle and distance and lagging a little, which is what a camera on a sideline does; it used to wait for the play to stop and then move to where it ended. A preset, a reset or a zoom takes over from it, and once the viewer has turned the camera themselves it never moves on its own again. The isometric and top-down cameras frame the whole field and never chase a play.
- Drive strips and charts draw only reported spots. A play without one keeps its row and says "Spot not reported".
- The field label names the play and its reported yardage, such as "Rush +7" or "Sack −8". "First down" is added only when the reported downs show a new set of downs, and the line to gain then sweeps out once.
- Emphasis follows the reported event: touchdown (the end zone lights in the scoring team's color), field goal, safety, turnover, penalty flag and review. A kick the provider called good lights the gate between the uprights, which is the one moment the goal posts are the subject and the one thing that told a kick that counted from one that did not. In the holographic style, sheets of light rise at the line of scrimmage and the line to gain, a beam tracks the ball, and a touchdown raises a column of light and sparks in the scoring team's color. On the game page **the arena answers a reported score**: the crowd takes the scoring team's colour for a few seconds while camera flashes pop through the stands, each seat at its own moment. It is decoration keyed to a reported score, and it says nothing about the real venue or the real crowd. Timing bands:
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
- `npx tsx scripts/capture-lines.ts --league nfl --live` records a sportsbook's line while games are actually running, so a replay of those games can rewind it. Unlike the exchange's prices, this one cannot be captured afterwards: there is no endpoint that says what a line was at a past moment, so it has to be watched at the time. It writes to `fixtures/lines/` after every round, so stopping it keeps what it has, and it refuses a game that is already final.

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
- **Field sounds** are separate, also off by default, and switched on in Display settings, which plays a test sound. On a game page and nowhere else, each play the field draws gets a short tone of its own: a touchdown, a field goal, a turnover, a first down, a sack, a long gain, a punt and a kickoff. What a play sounds like is decided from the reported play alone; a play the provider later corrected, settled or sent to review makes no sound, because it was never a moment. They follow the same animation the field draws, so they keep the spoiler delay and sound a play you step onto or watch in the reel exactly as they sound live, and they are rate limited to one every 220ms under a shared ceiling.
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
- **Demand rendering.** Frames render only for data changes, scrolling, layout shifts and running animations. The game page's arena is static apart from the few seconds it answers a score, so at rest it adds no frames at all.
- **The arena is geometry, not a model.** The bowl is four tiers of merged steps shaded per vertex by height and by which way each face points, so one draw call carries the whole gradient and the rows still read from above. The crowd is one point cloud, and its celebration is patched into three.js's own points shader rather than replacing it, so the flashes cost one draw call and three uniforms. The four towers each throw a soft pool of light on the turf, so the field is lit rather than lighting itself, and the whole bowl darkens with distance from the camera, which is haze: two instructions and one varying, rather than scene fog, which would have meant turning fog off on every material the field shares with thirteen cards. The arena is eight draws in total, and it is only ever built for the game page in the holographic style with Full effects. Measured figures for the whole page are in [docs/VERIFICATION.md](docs/VERIFICATION.md).
- **Diagnostics.** `window.__gridironGraphics` reports the renderer's counters and can drop the WebGL context; on a game page `window.__gridironField` reports what the field is doing, each layer writing its own part of it as it draws. Both are getters, so neither costs a frame anything, and `e2e/field.spec.ts` reads the second to check the things about the field that cannot be checked by looking at a still: how the ball turns, how much of a play's path has been drawn, which drive is on the field, what the stands are answering, and what the camera is doing.
- **Shared resources.** Geometry and materials are shared, and goal posts and pylons are merged into single draw calls. The turf texture is drawn once per league. End-zone textures are reference-counted per team.
- **Offscreen suspension.** A field's 3D scene unmounts when its card is far from the viewport.
- **Adaptive resolution** depends on the effects setting, the number of fields and measured frame cost.
- **Atmosphere.** The page background is one small fragment shader in raw WebGL (no three.js): a grid floor, a horizon glow, light beams and dust. It renders at reduced resolution and about 30 frames a second, holds a still frame when effects or motion are reduced, pauses while the tab is hidden, and is left out in 2D mode.
- **Performance modes:**
  - Full: 3D with animation.
  - Reduced: 3D with fades, at lower resolution.
  - 2D: SVG fields drawn from the same markings, and no WebGL at all. They are lit by the same reported sky through the same arithmetic, drop their mowing stripes on a surface that cannot be mown, and carry the same readings, including the attacking arrow in the colour of the team the provider says has the ball and the current drive, shaded from where it began to where the ball is, with a dashed line at the play it started from and one tick along the sideline for each play the provider gave an end spot for. It is the same `driveTrack` reading the 3D field and the drive chart take, so the three cannot disagree.
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
             probability, market price history, the tape, team pages, push payloads, QR codes,
             delay buffer, replay frames, play animation planning, boards, version
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
docs/        case study, deployment decision, proposals, tape persistence, providers,
             verification report, completion checklist, screenshots
```

## The shared boundary

`shared/` is the code both the browser and the server run. It is the most
structural decision in this repository and the least obvious from the file tree,
so it is worth saying plainly.

Three kinds of thing live there:

- **The normalized model.** `shared/model.ts` is what a game *is* here. A provider
  adapter's only job is to produce it; nothing above the adapter knows what ESPN's
  payload looks like.
- **Arithmetic about the model.** Where a drive started and how far it has come
  (`driveTrack`), the game as it stood at a given play (`replayFrames`), what a
  lane on the tape looks like, how a price moved, what counts as a moment worth
  announcing.
- **Facts about football.** Field geometry, the rulebook markings, how a play type
  should move.

**Why not put it in the server.** The browser needs the same answers. The field
and the drive chart both draw a drive; if the server sent a drawing and the client
drew another, the two would disagree about the same drive and no test would catch
which was right. The client rewinds to an earlier play, and the score, the clock,
the scorebug and the odds all have to agree about that moment; they agree because
one function derives it.

**Why not put it in the client.** The server needs the same answers too, before
any browser is involved: to decide what changed since the last poll, to build a
delta small enough to stream, to decide that a play is a touchdown worth an alert,
and to record a lane on the tape for a game nobody has open.

So the rule is: **if the browser and the server could ever disagree about it, it
goes in `shared/`.** Rendering lives in `src/`. Talking to a provider lives in
`server/`. The answer they both need lives between them, computed once.

Two consequences worth knowing before editing it:

- `shared/` may not use Node or browser APIs. It is imported by both, and by the
  tests, which run in a node environment with no DOM.
- Every relative import in `api/`, `server/` and `shared/` names its `.js` file,
  because Vercel loads the function as plain Node ES modules one file at a time.
  TypeScript, Vite, Vitest and esbuild all map that name back to the `.ts` source.
  `tests/serverlessImports.test.ts` holds the rule, and `npm run check:serverless`
  loads the function the way Vercel does to prove it.

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
- `GRIDIRON_CAPTURE=1` writes the design screenshots in `docs/screenshots`, and `GRIDIRON_PERF=1` records the `docs/perf*.json` measurements.
- **The screenshots are checked in deliberately**, as the visual record each cycle was judged against, and they are the largest thing in the repository: about 37 MB across 40 files, against 425 files in total. They are full-resolution captures at twice device scale, which is what makes them worth keeping and also what makes them large. CI regenerates the measurements as artifacts rather than committing them, for the opposite reason: a number goes stale silently, a picture does not.
- Kalshi is never called in tests. Its unit tests use a stand-in with Kalshi's field names and made-up prices, and the replay tests read the prices captured in `fixtures/kalshi`.

## License

The code is [Apache 2.0](LICENSE). Apache rather than MIT for two reasons that are specific to this project: it grants patent rights explicitly, and its section 6 says in so many words that it grants no trademark rights, which matters for something that draws other people's marks on a field.

What that covers, and what it does not:

- **Covered:** everything in this repository that was written here. The engine, the normalization, the field renderers, the shared arithmetic, the tests and the captured fixtures.
- **Not covered, and not ours to license:** the data. Scores, play-by-play, win probability and venue records come from ESPN's public but undocumented endpoints, sportsbook lines through them, and prices from Kalshi's public market data. None of it is redistributed here beyond the captured fixtures kept for tests, and none of it comes with any grant from its owner. Reusing this code does not give you a right to their data, and their terms are between you and them.
- **Not covered:** team names, logos and marks. They belong to their clubs and leagues, they are fetched from the provider at runtime rather than stored here, and no licence in this repository conveys any right to them.
- **Not covered:** the wordmark and the visual identity of Gridiron itself.

There is no warranty, and none is implied by the fact that this runs. The upstream is unofficial and has refused this deployment before; see [Data sources and coverage limits](#data-sources-and-coverage-limits).

---

An independent product by [John Jayasankar](https://johnjayasankar.com/), part of [Labs](https://labs.johnjayasankar.com/). Not affiliated with the NFL, the NCAA, ESPN, DraftKings, Kalshi or Sportradar.
