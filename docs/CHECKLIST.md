# Completion checklist

How each requirement was met and how it was checked:

- **Unit**: Vitest (`npm test`)
- **E2E**: Playwright journeys against the production build in replay mode (`npm run test:e2e`)
- **Browser**: checked by hand in the in-app browser, against the live ESPN feed or the replay lab
- **Screens**: design screenshots in `docs/screenshots`

Limits are stated where something could not be verified. Measured results are in [VERIFICATION.md](VERIFICATION.md).

## Product views

| Requirement | Status | Evidence |
| --- | --- | --- |
| Slate: responsive grid, live first, then scheduled and final | Done | E2E `slate › lists live games first…`; Screens `slate-390/768/1440/1920` |
| Focus: 1, 2 or 4 games; replace and swap | Done | E2E `focus holds 1, 2 or 4 games…` |
| Game page: shareable route | Done | E2E `opens directly from a shareable URL`, `opens a historical play straight from a shared link` |
| Large 3D field; isometric, broadcast, top-down and reset cameras; restrained orbit and zoom | Done | E2E `switches camera presets…`; Screens `game-1440-isometric/broadcast/top`. Orbit: no pan, polar and distance limits, wheel zoom only after clicking the field |
| Scoreboard, situation, drive explorer, play-by-play with filters, search, jump and click-to-historical | Done | E2E `filters and searches plays…`, `replays a drive from the drive explorer…` |
| Scoring timeline, team stats, broadcast information | Done | E2E `…jumps from the scoring timeline`; Browser |
| Replay controls, catch-up summary, Back to live | Done | E2E `replays plays with play, pause, step and scrub, and flags new live plays` |
| Wall: full screen; 4, 9 or 16; compact and comfortable; exit | Done | E2E `the wall shows 4, 9 or 16 games and exits with Escape`; Screens `wall-9/16-1440` |

## Header and page frame

| Requirement | Status | Evidence |
| --- | --- | --- |
| Logo (original Gridiron mark) | Done | `public/favicon.svg`, `src/components/Logo.tsx` |
| Live, Today and date selector | Done | Browser; E2E uses replay days |
| All, NFL and College | Done | E2E `filters by league, search text and live-only` |
| Search and command palette | Done | E2E `the command palette finds a game…` |
| Favorite-team filter | Done | E2E `a team favorited from the palette drives the favorites filter` |
| Layout controls, alert settings, appearance toggle | Done | E2E `appearance starts at Night and a change persists across reloads`, `alert settings persist…` |
| Freshness indicator | Done | E2E outage journeys check `state-stale` and `state-connected` |
| Live count, monitored count, notable situations, collapsible moments rail | Done | Screens; E2E rail and drawer |
| Honest empty state: upcoming kickoffs, completed games, a labeled demo; never fictional live games | Done | E2E `says plainly when nothing is live…`; Browser against the live feed on 14 Sep 2026 (no games live, next kickoff DEN at KC) |
| Footer with the exact credit and links | Done | `src/components/Footer.tsx` |

## Data

| Requirement | Status | Evidence |
| --- | --- | --- |
| ESPN scoreboard and summary, treated as undocumented | Done | `server/providers/espn`; validation in `parseScoreboard` and `parseSummaryShape` |
| NFL, FBS and FCS; D2 and D3 when discoverable | Done | Unit `discovers FBS and FCS…`, `includes Division II and III when asked`; groups discovered from ESPN metadata |
| Deduplicate games; discover across date boundaries | Done | Unit dedupe test; the engine keeps yesterday while its games are live, and the client follows yesterday in Live mode |
| Raw provider data kept out of presentation components | Done | The client imports only `shared/` types. Provider JSON is read only in `server/providers` |
| Typed provider interface; no paid credentials; keys server-side | Done | `server/providers/types.ts`, `docs/PROVIDERS.md`. Since 0.3 a Sportradar adapter exists, tested only against fictional fixtures (see Version 0.3) |
| A failure shows stale or unavailable, never fake data | Done | Unit `reports a league failure without inventing games`; E2E provider outage journeys |
| Normalized models: namespaced ids, unknown as null, spot provenance, separate clocks and timestamps | Done | `shared/model.ts`; Unit normalize tests |
| All status kinds | Done | Unit `status.test.ts` (overtime, college overtime, period breaks, forfeit, canceled, postponed) |

## Architecture

| Requirement | Status | Evidence |
| --- | --- | --- |
| React, TypeScript, Vite, R3F, Drei, Zustand, Lucide, Node server (shared polling, SSE), Vitest, Playwright | Done | `package.json` |
| One dev command; production build and start; deploy instructions; bounded serverless routes | Done | `npm run dev`, `npm run build`, `npm start`; README Deploy; `api/[...path].ts` and `vercel.json`. Vercel was not deployed; since 0.3 the adapter is exercised locally with the smoke test |

## 3D fields and placement

| Requirement | Status | Evidence |
| --- | --- | --- |
| Miniature field: base, bevels, forest turf, mowing stripes, lines, numbers, end zones, league hash marks, goal posts, team end zones, soft lighting, shadow | Done | `src/field/*`, `shared/fieldMarkings.ts`; Unit `fieldMarkings.test.ts`; Screens (classic turf is a Display setting since 0.3) |
| Ball marker with halo, line of scrimmage, first-down marker, attack arrow | Done | `BallLayer.tsx`; Screens `game-1440-broadcast` |
| Orthographic camera on cards; DOM text for score and clock; SVG fallback | Done | `CardCamera`; `FieldSvg`; E2E `2D mode draws SVG fields and no WebGL canvas` |
| Required placement cases: own 20, own 35, midfield, opponent 25, opponent 1, goal line, touchback, safety, turnover, goal to go (no end-zone marker), unknown ("Ball spot unavailable") | Done | Unit `placement-cases.test.ts`, `field.test.ts`; E2E `shows a field message instead of guessing…` |
| Schematic orientation labeled; centre axis unless lateral validated | Done | Field overlay "Schematic · AWY defends left". No live provider reports a lateral position; a labeled synthetic scenario shows the lateral path (Unit `lateral.test.ts`) |

## Motion

| Requirement | Status | Evidence |
| --- | --- | --- |
| Reported results only: sweep, arc and kick shapes; incomplete, sack and turnover treatment | Done | Unit `playAnimation.test.ts` |
| Bursts settle promptly; corrections show "Play corrected" without a repeat celebration | Done | Unit `settles a burst…`, `settles a correction quietly…` |
| Emphasis by event (touchdown, field goal, turnover, penalty, review, final) | Done | `BallLayer.tsx`; final has no celebration by design |
| Timing bands of 150 to 250, 300 to 500 and 500 to 1000 ms | Done | Unit `keeps every movement and effect inside the motion bands` |
| Reduced motion and a low-effects setting | Done | E2E `reduced motion removes decorative animation`; Full, Reduced and 2D modes |

## Cards

| Requirement | Status | Evidence |
| --- | --- | --- |
| Header, situation, field, footer | Done | `GameCard.tsx`; Screens |
| Stale, score-only and last-known states; real logos with fallback | Done | E2E `simulating an outage… marks cards as delayed`; `TeamLogo` fallback tile; last-known label from play-by-play |

## Alerts

| Requirement | Status | Evidence |
| --- | --- | --- |
| All alert kinds, including "Score changed" | Done | `shared/alerts.ts`; Unit `alerts.test.ts` |
| Scope, per-kind toggles, thresholds, quiet, per-game mute, snooze | Done | Alert settings dialog; E2E persistence and mute journeys |
| Sound off by default, enabled only by user action | Done | E2E checks the default; audio output itself was not checked automatically |
| Optional notifications, requested only after the user enables them | Done | The permission request is issued only from the toggle. The real prompt was not exercised in automation |
| Moments feed, toasts, badges; jump, add to focus, view play | Done | E2E moments journey; Screens |
| Reliability: baseline, no duplicates, revisions, withdrawn, red-zone transitions, fourth-down dedupe, grouping, late updates | Done | Unit `alerts.test.ts`, `alerts-burst.test.ts`; E2E `a touchdown reversed on review is withdrawn…` |
| Timeline jumps rebaseline alerts | Done | Browser (replay seek); `useAlerts` |

## Watch next, replay and delay

| Requirement | Status | Evidence |
| --- | --- | --- |
| Deterministic tiers with reasons; no probabilities; stale demoted; stable pinned positions; kickoff, favorites, closest and watch sorts | Done | Unit `watch-delay.test.ts`, `selectors.test.ts` |
| Drive replay: play, pause, step, scrub, speeds, scoring and current-drive jumps, back to live, "New plays available", gaps shown | Done | E2E drive replay journeys; gap rows in play-by-play |
| Spoiler delay: Off, 15, 30, 60 or custom on one timeline; no leaks; honest buffering | Done | Unit delay buffer; E2E `a spoiler delay buffers…` |

## Updates, performance and persistence

| Requirement | Status | Evidence |
| --- | --- | --- |
| Adaptive centralized polling, bounded concurrency, budget, jitter, timeouts, backoff, dedupe, cancellation, resync | Done | Unit `fetcher.test.ts`, `engine.test.ts` |
| Freshness states; no local clock countdown | Done | FreshnessIndicator; clocks come straight from the provider |
| Ordering and corrections | Done | Unit ordering, dedupe and revision tests |
| One shared canvas, scissored views, shared geometry, demand rendering, offscreen suspension, adaptive DPR | Done | E2E `draws twelve or more fields through one shared canvas`; perf measurements |
| Full, Reduced and 2D modes; WebGL context loss | Done | E2E `a lost graphics context falls back to 2D…` |
| Tested with 12 or more fields | Done | E2E (13 fields) and `docs/perf.json` |
| Persistence of preferences, boards (save, duplicate, rename, delete with undo), team boards by day, validated share URLs | Done | Unit `boards.test.ts`; E2E boards and broken-link journeys |

## Interaction, layout and accessibility

| Requirement | Status | Evidence |
| --- | --- | --- |
| Shortcuts: Cmd or Ctrl+K, Esc, 1, 2, 3, L, M, ? | Done | E2E palette, shortcuts, wall and Escape journeys |
| Copy summary, share link, reset layout, data and sources panel | Done | Game page actions; Boards dialog; Help dialog |
| Broadcast links only to verified pages | Done | Only the provider's game page link, restricted to ESPN hosts; no stream links |
| Responsive at 390, 768, 1440 and 1920 | Done | E2E `phone, tablet and wide layouts never scroll sideways`; Screens |
| Accessibility: landmarks, skip link, focus trap, Escape, focus return, live region, text alternatives for fields | Done | E2E `skip link, modal focus trap, Escape and focus return`. Since 0.3 an automated axe-core audit runs as well (see Version 0.3) |
| Deliberate empty and failure states | Done | Empty day, filtered empty, provider unavailable, detail unavailable, replay session ended; since 0.3 a not-found page and a view recovery panel |

## Replay lab and tests

| Requirement | Status | Evidence |
| --- | --- | --- |
| Replay and demo lab from captured real fixtures; synthetic scenarios labeled; same pipeline as live | Done | `server/replay`; E2E uses it throughout |
| Meaningful unit tests | Done | See VERIFICATION.md for counts |
| Playwright journeys (25 or more) | Done | 60 journeys in `e2e/` run in Chrome, 7 of them also in Firefox and WebKit, plus screenshot capture and performance recording, which are opt-in. One guards that field controls stay above the 3D view |
| Screenshots to assess the design | Done | `docs/screenshots` (33 images) |

## Deliverables

| Requirement | Status | Evidence |
| --- | --- | --- |
| README: run, build, deploy, data sources, update strategy, coverage limits, schematic conventions, replay, alerts, graphics performance, licensed provider | Done | `README.md` |
| Honest verification report | Done | `docs/VERIFICATION.md` |
| Completion checklist | Done | This file |
| No changes published to existing websites | Done | Nothing deployed or pushed |

## Version 0.2

| Requirement | Status | Evidence |
| --- | --- | --- |
| Director mode in Focus and on the wall: a reason for every pick, 45 s minimum dwell, cut-ins for breaking moments, Stay and Skip, next kickoff when idle | Done | Unit `director.test.ts` (hysteresis, one cut per moment, lock, skip, muted and stale games); E2E `a Focus slot follows a live game with its reason, and stays or skips on request`, `the wall gives the director a large tile and never repeats that game in the grid`; Screens `focus-director-1440`, `wall-director-1440` |
| While you were away: a snapshot on leaving; reported scores, turnovers, kickoffs and finals on return; no replay of a game's history; replays compare within their own session | Done | Unit `digest.test.ts`; E2E `coming back after time away summarizes what was reported, and can be dismissed`; Screens `digest-1440` |
| Game flow: margin across the game clock, college overtime spacing, lead changes, ties, largest leads; inspectable, keyboard-accessible points | Done | Unit `gameFlow.test.ts`, `flowStats.test.ts`; E2E `game flow names each score, opens it on the field, and moves by arrow keys`; Screens `game-1440-flow` |
| Leaders and attendance from the provider summary; hidden in a replay until the game is final | Done | Unit `leaders.test.ts` (normalization, malformed input, deltas); E2E `leaders and attendance appear for a final game`, `a replay does not show leaders before the game ends`; Screens `game-1440-leaders` |
| Play readouts with reported yardage; first downs read only from reported downs; line-to-gain sweep; team-colored touchdown end zone | Done | Unit `playReadout.test.ts`; Browser (replay lab) |
| Moment thumbnails from reported start and end spots | Done | E2E `play moments carry a field strip of the reported start and end`; Screens `moments-1440` |
| Previous and next game: buttons, `[` and `]`, scoreboard swipe | Done | E2E `[ and ] move to the previous and next game in slate order`. The swipe was not exercised on touch hardware |
| Keyboard card navigation: `J`, `K`, arrow keys, `P`, `F` | Done | E2E `J and K move across cards; F adds the focused game to Focus and P pins it` |
| System appearance that follows the device | Done | E2E `System appearance follows the device setting` |
| 3D layer split into its own chunk, with a clean fallback when a chunk cannot load | Done | Build output in VERIFICATION.md; E2E `a lost graphics context falls back to 2D, says so, and recovers` passes with the lazy canvas |
| Precompressed assets, gzipped JSON, 404 for a missing chunk | Done | Unit `http.test.ts`; E2E `precompressed assets, gzipped JSON, and a 404 for a missing chunk` |
| Web app manifest, icons, and a service worker that never caches `/api` | Done | E2E `a web app manifest with icons, and a service worker that leaves live data alone`. Installing on a phone was not tested |

## Version 0.3

| Requirement | Status | Evidence |
| --- | --- | --- |
| Holographic look: Dark by default, WebGL atmosphere (still when effects or motion are reduced, paused while hidden, absent in 2D), glass cards, boot sequence, view transitions | Done | E2E `appearance starts at Night and a change persists across reloads @cross`, `2D mode draws SVG fields and no WebGL canvas`, `reduced motion removes decorative animation`; Screens. The effects were reviewed in screenshots, not asserted frame by frame |
| Holographic fields, stadium and camera fly-in; classic turf in Display settings | Done | `src/field/FieldModel.tsx`, `BallLayer.tsx`, `Stadium.tsx`, `cameras.tsx`; Screens `game-1440-*`. Reviewed in screenshots only |
| Drive tracker on live cards and a drive chart on the game page, drawn only from reported spots | Done | Unit `driveTrack.test.ts`; E2E `live cards carry the current drive, and the game page charts it play by play @cross`; Screens `game-1440-drive` |
| Team pages: hero, record, streak and points, next game and last result, season timeline with bye weeks, margins, schedule; replay hides results after its clock and the as-of-today record | Done | Unit `team.test.ts` (captured Buffalo and Alabama documents), `teamReplay.test.ts`, `teams.test.ts`; E2E `a scoreboard team name opens the team page, shown as of the replay clock @cross`; Screens `team-1440` |
| Watch parties: host view sync, guests follow, explore, return and see the end; limits and host token; unavailable on serverless | Done | Unit `party.test.ts`, `partyRoutes.test.ts`, `rateLimit.test.ts`, `qr.test.ts`; E2E `a guest follows the host into a game, explores alone, returns, and sees the party end`; Screens `party-1440`; the Vercel entry answered 503 with the reason when run locally |
| Push alerts: RFC 8291 encryption, VAPID, subscription store, the alert engine on favorite teams, corrections, limits; unavailable in replays and on serverless | Done, not delivered to a real push service | Unit `webpush.test.ts`, `pushStore.test.ts`, `pushService.test.ts` (a local receiver decrypts each message), `pushRoutes.test.ts`; E2E `alert settings say plainly when push alerts are unavailable` |
| Pop-out tracker with Document Picture-in-Picture | Done | E2E `the game page pops out a live tracker window where the browser offers one`, with a stand-in popup, because headless Chrome has no Document Picture-in-Picture |
| Sportradar adapter and pushed updates in the engine | Done, never run against the real API | Unit `sportradar.test.ts`, `sportradar-push.test.ts` (fictional fixtures and a local stream server), `enginePush.test.ts` |
| Lateral ball position in a labeled synthetic scenario only | Done | Unit `lateral.test.ts`; E2E `the lateral position test scenario is labelled synthetic and says how the ball is placed` |
| Automated accessibility audit | Done | E2E `accessibility audit` (slate in both themes, game page, team page, three dialogs, not-found page): no serious or critical violations |
| Firefox and WebKit | Partly | WebKit passed the 6 `@cross` journeys. Firefox could not start on the build machine (see below); the CI workflow includes it |
| Not-found page and view recovery | Done | E2E `an unknown address shows a way back to the slate @cross`; accessibility audit of the not-found page |
| Deployment files: Dockerfile, CI workflow, environment example, share image and metadata, robots.txt, manifest shortcuts | Done | Files in the repository. The Docker image was not built and the workflow has not run |
| Bounded Vercel entry: polling, team pages, parties and push unavailable with reasons | Done | `npm run smoke` against `api/[...path].ts` served locally; checked responses for team pages, watch parties, push and the stream |
| Team page and watch party dialog load on first use | Done | Build output in VERIFICATION.md; E2E team page and watch party journeys pass with the lazy chunks |

## Version 0.4

| Requirement | Status | Evidence |
| --- | --- | --- |
| Win probability on live cards: ESPN's value after the latest play, a meter in team colors and the latest swing | Done, not seen during a live game | Unit `winProbability.test.ts`, `espnOdds.test.ts`; E2E `live cards carry a win probability meter and the sportsbook line @cross`; Screens `slate-*` |
| ESPN's matchup predictor before kickoff | Done | Unit `espnOdds.test.ts` (captured pre-game documents); Browser: DEN at KC against the live feed |
| Game page panel: win probability at the latest or inspected play with its swing, the sportsbook's spread, moneyline and total with opening values, the result against the closing lines, and Kalshi prices | Done | E2E `the game page shows win probability and the closing lines, and says replays have no Kalshi prices`; Browser: DEN at KC against the live feed, and ARI at LAC final in the replay lab ("ARI covered +8.5", "Under 47.5, 40 points"); Screens `game-1440-odds` |
| Win probability in Game flow, with the biggest swings opening their plays | Done | Unit `winProbability.test.ts`; E2E `game flow switches to win probability, and a big swing opens its play on the field`; Screens `game-1440-win-probability` |
| Sportsbook lines from ESPN (DraftKings), checked against the game's teams | Done | Unit `espnOdds.test.ts` (lines for other teams are refused); live reading for DEN at KC in VERIFICATION.md |
| Kalshi prices with no account or key: matched by US Eastern date and team codes only, contracts nearest the sportsbook's lines, midpoint or last trade, 15-second refresh while live, stale after 90 seconds, dropped after 10 minutes | Done, read before kickoff only | Unit `kalshi.test.ts`, `marketService.test.ts`; live reading for DEN at KC in VERIFICATION.md; `/api/health` reports market status |
| Odds formats (American, decimal, chance) and a setting that turns odds off | Done | Unit `odds.test.ts`; E2E the game page journey switches to Chance; E2E `turning odds off in Display settings removes them from cards and the game page` |
| Win probability, lines and prices in the same deltas as scores | Done | Unit `winProbability.test.ts` (detail deltas and merges), `marketService.test.ts` (prices in slate deltas). The spoiler delay holds the whole presented state (E2E `a spoiler delay buffers…`); it was not asserted for odds separately |
| Replay lab: captured closing lines, win probability cut at the replay clock, no Kalshi prices | Done | Unit `replays win probability only up to the replay clock`; E2E the game page journey |
| Vercel: Kalshi prices read on request within 3 seconds; `GRIDIRON_MARKETS=off` | Done, not deployed | The serverless entry served locally: prices attached on the first slate request (1.38 s), and `npm run smoke` passed |
| Accessible odds and win probability | Done | The axe-core game page audit includes the panel; E2E finds the meter by its accessible name; spacing in the accessible text checked in the browser. The pop-out meter and the win probability in card summaries were not asserted separately |

## Version 0.5

| Requirement | Status | Evidence |
| --- | --- | --- |
| The Vercel function loads the way Vercel runs it: Node ES modules, each file transpiled on its own | Done, not deployed | Unit `serverlessImports.test.ts` (every relative import in `api/`, `server/` and `shared/` names its `.js` file), `version.test.ts`; `npm run check:serverless` in CI, and with `--live` locally. The same check run on the 0.4 code failed with "Cannot find module …/server/engine" |
| Kalshi price history for followed games: hourly over the week before kickoff, minute by minute from an hour before, read every 45 seconds while live and every 5 minutes before, sent with game detail only when it changes | Done, not seen during a live game | Unit `marketService.test.ts` (history reads and reuse; the engine attaching history as a new detail version), `marketHistory.test.ts` (Kalshi candles, the pricing rule, flat runs, deltas) |
| Game flow draws Kalshi's price beside ESPN's win probability, placed between plays by time and never past the latest play shown | Done | Unit `marketHistory.test.ts` (placement, the opening price, the cut after the latest play); E2E `game flow switches to win probability, and a big swing opens its play on the field`; Screens `game-1440-win-probability` |
| Odds panel price trend and the move since it began | Done | E2E `the game page shows win probability, the closing lines, and Kalshi prices as captured`; Screens `game-1440-odds`. A finished game's trend was not asserted separately |
| Kalshi prices captured for the NFL Week 1 replay's 13 games, cut at the replay clock and ending with each game; none for synthetic scenarios | Done | `scripts/capture-kalshi.ts`, `fixtures/kalshi/nfl-20260913.json`; Unit `replayMarket.test.ts` |
| Game page in two filled columns on wide screens; drive replay under the field on phones | Done | Layout measured in the browser at 1440 by 900; Screens `game-1440-*`, `game-390-panels` |
| The game page, settings dialogs and command palette load on first use and are fetched when the page is idle | Done | Build output in VERIFICATION.md; E2E game page, dialog and palette journeys pass with the new chunks |
| Scoreboard shows the down, distance and spot beneath the clock | Done | Screens `game-1440-isometric` |
| Stadium light towers glow instead of showing flat white panels | Done | Screens `game-390-panels`; reviewed in screenshots only |

## Not verifiable during the build

- **A live game.** Nothing was live while Gridiron was built (Monday 14 September 2026, before Monday Night Football). The live feed was verified for scheduled and final states and the honest empty state. In-game behavior was verified with captured real games in the replay lab, through the same normalization and engine. Since 0.4 that includes win probability after each play and the closing lines. Win probability updates, line movement during a game, Kalshi prices and Kalshi price history were not observed during a live game; Kalshi prices and history were read only for a scheduled game.
- **Firefox.** Playwright's Firefox build (1543) exits at launch with "Could not find profile folder" on the build machine's macOS 27.0 beta, both inside and outside the command sandbox, so no Firefox journey ran. CI runs them on Ubuntu, but the workflow has not run yet.
- **Safari itself.** The WebKit journeys used Playwright's WebKit build, not the Safari app.
- **The Vercel deployment.** Not deployed. The serverless entry was served and checked locally.
- **The Docker image.** Not built; building would download base images.
- **Real push delivery.** No message was sent to Google, Mozilla, Apple or Windows push services, and no notification was shown by a browser. Encryption, signing and delivery were tested against a local receiver.
- **Sportradar.** No key was used and the real API was never called.
- **Document Picture-in-Picture.** The pop-out window was tested with a stand-in popup.
- **Devices.** Installing Gridiron as an app, push permission prompts on phones, the scoreboard swipe and a service-worker start during a real network drop were not tried on phones or tablets.
