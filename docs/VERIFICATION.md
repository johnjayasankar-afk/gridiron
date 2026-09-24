# Verification report

Eight builds are recorded here: **0.6.0** first, then **0.5.2**, **0.5.1**, **0.5**, **0.4**, **0.3**, **0.2** and the original **0.1** report.

## Version 0.6.0

Recorded Tuesday 22 September 2026. It covers the tape, the effects added to it, and three faults the work exposed in the version that was already sitting uncommitted.

### Bundle

| Chunk | Size | gzip | Loads |
| --- | --- | --- | --- |
| App (`index-*.js`) | 359.5 kB | 115.3 kB | At startup |
| Styles (`index-*.css`) | 127.1 kB | 26.1 kB | At startup |
| The tape (`TapeView-*.js`) | 11.7 kB | 4.5 kB | On first use, fetched when the page is idle |
| Game page (`DetailView-*.js`) | 67.0 kB | 19.8 kB | On first use, fetched when the page is idle |
| The 3D field (`Field3D-*.js`) | 58.4 kB | 19.2 kB | With three.js, once the app has started; never in 2D |

- The startup bundle is **smaller than 0.5.2's** with a whole view added, because the tape's code is split out and fetched when the page is idle. The recorder is not split: it has to run from the moment the page does, or the tape would only begin when somebody looked at it.
- The pulse and the palette's biggest swing are on the slate and in the header, so they are **not** split. With the play each reading followed, they are the whole of the startup bundle's growth this version: **0.8 kB gzipped**, 114.2 to 115.0. The tape's own chunk grew 0.3 kB gzipped for the moment link, and the stylesheet 0.2 kB.
- The effects added to the tape cost **0.37 kB gzipped** of CSS and nothing at startup.

### Performance

Production build, replay mode from 35% at 60x, thirteen live fields at 1920x3200, on an otherwise quiet machine. Four runs.

| Measure | 0.6.0 | 0.5 |
| --- | --- | --- |
| Fields drawn | 13 views through 1 field canvas, plus the atmosphere canvas | Same |
| Draw calls per frame | 138 to 176 | 138 to 176 |
| Triangles per frame | 23,354 to 25,886 | 23,354 to 25,884 |
| Textures / programs | 33 / 10 | 33 / 10 |
| Long tasks over 50 ms | 0 in three runs of four; one run had a single 53 ms | 0 |
| JS heap after 30 s | 21 to 24 MB | 34 MB |
| Average CPU frame cost | 1.53 to 3.47 ms across four runs | 1.48 to 1.97 ms, one run |
| Game page (1 field, replay playing, cameras cycling) | 24 draw calls, 3,584 triangles, 10 programs, 0.66 to 0.84 ms over three runs | 24, 3,584, 10, 0.55 ms |

**What is comparable here and what is not.** The geometry columns are: draw calls,
triangles, textures and programs are identical to 0.5 on both the slate and the
game page, which is what it means to say that none of this work reaches the
canvas. The tape is DOM and SVG and the effects are CSS.

The frame cost columns are **not** comparable. 0.5 was recorded on another
machine on another day and in a single run; the spread above is four runs on
this one. Read them as two separate readings, not as a change. What can be said
about this build's frame cost is measured directly rather than by comparison,
under "The tape's frame cost" below.

- The heap is lower than 0.5's, not higher, despite the recording. A full day of tape is about 750 kB of numbers in session storage.
- An earlier reading of this scenario showed a 95 ms long task and 42 MB. It was the measuring machine, not the build: the same scenario **with the recorder disabled** gave 3, 7 and 7 long tasks of up to 178 ms, worse than with it on. The numbers above were taken with the dev servers stopped.
- A single sample of the game page once read 28 draw calls and 4,070 triangles. Three runs since read 24 and 3,584 every time, matching 0.5, so that sample was caught mid camera move and is not a change.

### The tape's frame cost

The property the view rests on is that a lane's drawing is a function of its own data and its column's width, and of nothing that moves.

- The clock and the pointer were props on the memoised lane at first, so a dot moving four pixels rebuilt every ribbon, quarter, score and red zone on the page. They are now two absolutely placed elements moved by a transform.
- Measured in the browser: scrubbing 120 times across a stopped card rebuilt **0** nodes in the lane drawings, worst frame 9.3 ms, no frame over 16.7 ms. Sitting still for six seconds rebuilt 4 nodes, which were four genuinely new marks as the replay recorded them.
- `e2e/tape.spec.ts` asserts the zero: it tags every node in every lane drawing, scrubs across the tape with the replay paused, and counts what came back new.
- Neither moving mark carries `will-change`. It would pin two compositor layers per lane, and a Saturday card of sixty lanes is a hundred and twenty of them held for a 1.5px line and a 7px dot.

### The pulse on a card

The same property, on the view people actually live on, where there are as many drawings as there are games. The pulse takes a game id and nothing else, so nothing that moves can reach it.

- Measured in the browser against a running replay, at the recorder's cap of 900 readings: building the shape took **0.7 ms**, and building and laying out **sixty** worst case pulses took **1.6 ms**. On that evidence the drawing was left at full resolution rather than decimated, because a decimation is a change to a measurement and this one would have bought two milliseconds.
- Worst case path data is 33 kB per pulse at 900 readings. Real tracks in a replayed afternoon were 60 to 91 readings and 0.6 kB per path.
- `e2e/tape.spec.ts` asserts a stopped game never redraws its pulse, by tagging every path and counting what came back new after three and a half seconds of clock ticks.
- A second test reads the movement off a lane on the tape and then off that game's card and requires them to be the same number, so one recording read twice cannot disagree with itself.
- One measurement in this session was thrown away: two `requestAnimationFrame` waits reported 1.9 s. The Browser pane was hidden and not compositing, so frames were throttled. The figures above are from `performance.now()` around synchronous build and layout, which that does not affect.

### The arena and the ball

Everything here is decoration on the game page, and decoration has to be cheap and has to be looked at rather than reasoned about. Both were done in headless Chrome, where frames are real: the app's own browser pane throttles `requestAnimationFrame` while it is hidden, which made one earlier attempt report a single frame per play and a 1.9 s wait for two frames. Neither figure was used.

- **The ball's flight was measured, not eyeballed.** Sampling the ball through a drive replay gave 135 in-flight frames across 373 samples. A pass climbs (nose +0.34 rad), levels at the top (0.0) and turns down into the catch (−0.78), and the spin accumulates monotonically, about 1.1 turns across a pass. The clamp on the nose angle earns its place: at the moment of release a pass has climb and no reach yet, which without a floor on the reach would stand the ball on its end.
- **The arc trail was being drawn and never seen.** Its tube was 0.16 of a yard in radius, which at the game page's camera is under one pixel and on a card about half of one. Found by instrumenting the layer rather than by looking, because there was nothing to look at.
- **The reveal needed the ramp to move with it.** The trail's texture is almost clear where a play started and bright where it ends, so drawing the first half of an arc showed only the clear half. The ramp is squeezed into the drawn part now, which is also what makes the head of the trail the bright end.
- **The bowl was there all along.** Painting the stands bright red for one throwaway build showed the geometry filling the frame on every side, correctly placed and never occluding the field. At `#07130d` none of it had ever been visible.
- **Cost, production build, game page at 1440x900 with the drive replay playing and the camera presets cycling:** 27 draw calls and 3,852 to 3,896 triangles across three runs, at **0.52, 0.67 and 0.70 ms** average frame. The 0.6.0 figure before this work was 0.66 ms, which sits inside that spread, so there is no frame cost to attribute to any of it. A fourth reading of 1.40 ms was discarded: it came from a run where both performance tests shared the machine, and the three runs above were run alone.
  - Draw calls and triangles are a single frame's counters, so they depend on what happens to be on screen when the sample is taken: a play in the air adds its arc, which is 480 triangles on its own. They are not a stable before-and-after either.
  - The celebration adds no geometry at all. It is patched into three.js's own points shader rather than replacing it, so the crowd stays one draw call and three uniforms.
  - `e2e/perf.spec.ts` now holds a ceiling of 45 calls and 6,500 triangles, with room above what is there, to catch a change that doubles the bowl rather than to fail on every tweak to it. Those assertions run only with `GRIDIRON_PERF=1`, as the rest of that file does.
- **The celebration was verified by its uniforms, not by a lucky screenshot:** the shader patch reported both of its anchors found, and the envelope was caught at 0.85 and 0.99 with the crowd carrying `#a40227`, the scoring team's colour.
- One thing this found about the app rather than the arena: jumping to a play is deliberately a burst and plays no effect, so a celebration can only be seen by stepping onto a score. The first attempt to film one jumped to it and saw nothing.

### The ball, the camera and the light

The second pass over the field. Everything here was looked at close up first, at a viewport wide enough to render the ball at a size it could be judged at, because the ball is the subject of every play and at 1440 wide it is about twenty pixels.

- **The ball was a scaled sphere and read as a pill.** It is a revolved arc now, which is the shape a football is. Verified by looking: the silhouette has points, the lace panel reads, and a college ball carries its two rulebook stripes where a pro ball carries none.
- **How the ball turns was measured, not eyeballed**, over 733 readings through a replaying drive. A pass climbs with its nose up (+0.21 to +0.51 rad), levels at the top and turns down into the catch (−0.74); its spin runs 0.93 to 8.03 rad, about 1.1 turns, and never backwards. A kickoff, over the same stretch, holds its spin at **exactly 0.00** and runs its pitch 0.29 to 13.58 rad, two and a sixth turns end over end. That is the claim: a thrown ball spirals and a struck ball does not.
- **The broadcast camera's pan is asserted on both sides.** `e2e/field.spec.ts` measures how far the camera travels while a play runs: more than 4 world units in the broadcast preset, less than 1 in the isometric one, and the ball stays inside the frame throughout.
- The ball, the arena's light and haze, the camera's pan and the field probe are all in the 3D field's own chunk, which is fetched with three.js and never in 2D mode. The startup bundle grew **0.08 kB gzipped** across this pass, which is the rulebook's line about the ball.
- **Cost, production build, game page:** 29 draw calls, about 4,175 triangles and 13 textures, at **0.67, 0.75 and 0.76 ms** average frame across three solo runs. The previous pass read 27 calls and about 3,880 triangles at 0.52 to 0.70 ms, and 0.6.0 before any of this read 0.66 ms. The rim, the lit pools and the haze are two draw calls and two shader programs between them; the ball's mark is one texture and no draw call at all, because it is the ball's own surface.
- **Cost, production build, the slate is unchanged by the ball's mark**, which is the point of building it only for the game page: 138 to 176 draw calls, 24,424 triangles and **33 textures**, the same count as before it existed, at 1.65 to 2.68 ms with no long task.
- **Cost, production build, the slate at 1920x3200 with thirteen live fields:** 138 to 176 draw calls, at most 24,424 triangles, frames **1.65 to 2.32 ms**, no long task over 50 ms in four runs. The 0.6.0 band was 1.9 to 3.47 ms and at most 25,886 triangles, so the slate is slightly cheaper than it was: the revolved ball has fewer triangles than the sphere it replaced, and none of the arena, the rim or the pools is ever built for a card.
- **Two readings were discarded rather than reported.** One slate run showed a single 146 ms long task and a 28 MB heap; three runs after it showed no long task at all and heaps of 24, 26 and 37 MB. The heap reading moves by half its own value between runs, so nothing can be attributed to a change from it, and the single long task was the machine rather than the page.
- **The ball's mark, and a double fetch it uncovered.** The decals are drawn at u = 0.60 and 0.90 on the lathe's own texture, either side of the laces at 0.75, so an elevated camera sees one or both; verified by looking at the ball at four times device scale, where the logo and its disc read clearly. The network was checked rather than assumed: the logos come back 200 with `access-control-allow-origin: *`, so they can be drawn into a texture at all, and a logo that will not load becomes the team's letters.
  - Writing the test found a real fault. The skin was keyed on the logo's address, and the provider hands out two addresses for the same picture: a game page starts with `500/ari.png` from the scoreboard and is given `500/scoreboard/ari.png` when the game's own detail arrives. Every ball was being painted twice and every logo fetched twice. It is keyed on the team and its colour now, and `e2e/field.spec.ts` holds it: one ball per team, and the two teams never share one.
- **One shader patch failed silently and was caught by counting.** The crowd's distance falloff was written against a string the file no longer contained, so it did nothing. Every patch is now asserted at the point it is written.

### The drive on the field

The third pass. The drive already existed as a tested reading in `shared/driveTrack` and was drawn only in a chart beside the field, so this is almost entirely a rendering of something the app already knew.

- **The view builds the drive once** and hands it to both the field and the panel. They cannot disagree about a drive, because there is only one reading of it, and `e2e/field.spec.ts` holds the field's understanding against the panel's own words: the play count the panel prints is the count the field has.
- **What is drawn is only what was reported.** A mark is drawn for each play the provider gave an end spot for, and the test holds marks plus unspotted plays at or below the drive's own rows. Held against rows rather than the play count, which is the provider's count of offensive plays and leaves out a kickoff: an earlier version of that assertion compared against the play count and would have failed on any drive that began with one.
- **Stepping through the drive grows it**, which a test walks six plays to confirm, because the reading is cut at the play being watched.
- **Two design choices were made by looking.** A solid line in the team's colour at the drive's start read as a third rule nobody could name beside the blue line of scrimmage and the amber line to gain, so it is dashed: a different kind of mark rather than a different colour. And a flat fill of team colour over the ground covered washed half the field, so the band is a ramp, faint where the drive began and strongest at the ball.
- **The gate between the uprights is an open box, not a sheet.** A sheet facing down the field is edge on from the broadcast camera, which watches from the side, and it all but vanished at the one moment it exists for. Caught by looking at a made field goal from that camera.
- **Cost, production build, game page:** 33 draw calls, about 4,215 triangles and 13 textures, at **0.72, 0.74 and 0.79 ms** average frame across three solo runs. The pass before read 29 calls and about 4,175 triangles at 0.67 to 0.76 ms. The drive is three draws and about forty triangles.
- **The slate is untouched:** 138 to 176 calls, 24,424 triangles, 33 textures, 1.71 to 2.50 ms, no long task. The drive is built for the game page only; a card already carries its own drive strip in the DOM.

### Each game's own field, and three shapes that were wrong

The fourth pass, looking for what each game already says about itself that the field ignored.

- **What the provider does not say was checked before anything was built.** The venue record carries only a name and an address: no roof, no surface, no capacity, in any fixture. So there is no indoor field, no grass against artificial turf, and no bowl sized to a real stadium. All three would have been invented.
- **What it does say is the home team**, and a real field carries that team's mark at the fifty. That is now drawn, from the same logo the ball wears, with the team's letters in a ring where no logo loads. On a card it is a quarter of the texture area the game page uses, because the mark is about sixty pixels across there.
- **Three play shapes were wrong, and the provider had said so all along.**
  - An extra point slid along the ground like a run. The provider reports that it was a kick on the `conversion` rather than in the kind of play, so nothing downstream had ever looked. It flies now, and a good one lights the uprights.
  - A blocked kick, of any sort, also slid along the ground. It is short, low and over quickly now.
  - An interception was one smooth arc from the throw to where the RETURN ended, which drew the ball flying to a spot behind the line of scrimmage. It is two legs now. The turn is drawn just past the further of the throw and the end of the return: a fixed distance downfield was tried first and **failed its own test**, because on a long return it landed short of where the return ended and drew both legs running the same way.
- **Cost, production build, game page:** 34 draw calls, about 4,215 triangles and 14 textures, at **0.73, 0.75 and 0.77 ms** average frame across three solo runs. The pass before read 33 calls at 0.72 to 0.79 ms. The mark at the fifty is one draw and one texture.
- **Cost on the slate, which is where thirteen of those marks live:** 151 to 189 draw calls (13 more, one per field), 24,452 triangles, 46 textures (13 more, one per home team), **1.69 to 2.60 ms**, no long task. The band before this pass was 1.65 to 2.68 ms across four runs, so the mark is inside the noise; it is 13 more draw calls, which is the honest cost of each field being its own.

### Smooth, measured rather than claimed

The fifth pass began by testing the claim instead of chasing it. Frame to frame gaps were recorded from `requestAnimationFrame` in the production build, which is what "smooth" actually means, alongside a `longtask` observer.

- **Game page, drive replay running, world at 30x for 40 seconds:** 2,400 frames, median gap **16.7 ms**, 95th 17.6, 99th 17.8, worst 31. **No frame over 32 ms and no long task at all.**
- **Slate, thirteen live fields, scrolling the whole page up and down continuously for 30 seconds:** 1,800 frames, median **16.7 ms**, 95th 17.5, 99th 18.5, worst 33. One frame over 32 ms in 1,800, and no long task.

Nothing was found to fix, so nothing was changed for its own sake. The pass went to capability instead.

### The reel

- It is the replay driver that was already there, walking the scoring plays instead of every play. What was missing was a way to say a jump was deliberate: landing on a play is a burst that draws no movement, which is right for a jump and wrong when the jump IS the thing being watched.
- `e2e/field.spec.ts` holds the part that matters: the scores are **drawn** rather than jumped to, which is checked by counting frames whose path is not a settle, since a burst is a settle. It also holds that the reel walks forward, that stopping it leaves the game where it is, that anything done by hand ends it, and that it starts from `R` and from the command palette as well as from its button.
- **Cost, production build, game page:** 34 draw calls, about 4,230 triangles, at **0.74, 0.77 and 0.79 ms** across three solo runs, unchanged from the pass before. The reel is orchestration; it adds nothing to a frame.
- One measurement was discarded: a run reading 1.10 ms was taken while the screenshot suite was running on the same machine. The three above were run alone.
- The screenshot suite also failed once during this pass, with `browserContext.close: ENOENT` on a trace file. That was self inflicted: a parallel performance run deleted `test-results` underneath it. Re-run alone, all twelve pass.

### The odds, as of the play you are looking at

- **What each figure actually does was measured before anything was changed**, over thirty seconds of real time at sixty times speed, which is about half an hour of game time. The provider's win probability took **10** distinct readings, the exchange's price **8**, and the sportsbook's lines **1**. Two of the three already moved with the game; the third has nothing in between an opening line and a closing one to move with.
- **The exchange's price now rewinds** to the play being looked at: the last price recorded at or before that play's wall-clock time, which is the rule the chart's own track already used. Unit tests hold the three things that could go wrong: that a price recorded after the play is never used, that the change is measured against the price standing at the play before, and that a play with no wall-clock time and a game with no record get nothing rather than a guess.
- **The trend stops at the play too.** Left running to the latest price under a heading that said "at this play", the block said two things at once. Caught by reading the rendered panel rather than the code: the header read "As traded at this play" and the line under it read "LAC to win 1¢, −79.5¢ since 1:03 PM".
- **The at-play price is in cents like the trend it sits under**, not in the odds format the tables use. The first version formatted it as American odds, so the same block showed "+251" above "56.5¢".
- **The sportsbook says what it cannot do.** While a play is being looked at, that block reads "Opening and closing lines, not play by play", so a closing line is never read as the line at that moment.

### A logo that would not settle

Reported from a screenshot: the same card showing its team logos on light discs in one moment and without them in the next.

- **Measured before anything was changed.** Watching the slate's logos for twenty five seconds: **thirty changes across twenty six logo frames**. Watching one of them for twenty seconds: nine changes, alternating between `nfl/500/scoreboard/mia.png` on a disc and `nfl/500-dark/mia.png` without one. So it was not only the disc flashing: the image itself was being swapped and reloaded every few seconds.
- **The cause was in the merge, not the view.** Two reports of the same game are merged, and that merge already kept the lines, the venue, the market, the broadcasts and the coverage when a newer report left them out. It took the teams wholesale. The scoreboard payload carries no `logos` array at all, so every team from it has no dark variant; each poll then erased what the richer report had found, and the next one put it back.
- **Fixed by the same rule the rest of the merge already used**, applied to a team's branding only: a logo, a colour, a location and a conference cannot become unknown, so a report that does not carry them does not erase them. A rank and a record can become nothing, because a team can fall out of the rankings, so those are still replaced.
- **After: one change in twenty two seconds**, which is the first paint, and no logo on a disc anywhere.
- `mergeTeam` also returns the newer team object unchanged when nothing was left out, so a report that carries everything costs nothing downstream.
- Held by a unit test for the merge and by an end-to-end test that watches a live card's logo for fourteen seconds and requires it to change image exactly once.

### A sweep for anything else

After the logo, the whole slate was swept for the same class of fault and for anything else worth fixing.

- **Console: two warnings, neither the app's.** Playwright blocking the service worker, and a `THREE.Clock` deprecation notice from inside three.js, which the app does not use directly.
- **Network: no failed requests and nothing over a 400** across a live replay.
- **Flicker: none left of the logo's kind.** Every rendered figure that went back and forth was watched for twenty five seconds; the only values that did were win probability and market prices, which are the provider and the exchange genuinely moving. The logo's pattern was the same value reloading, which no longer appears.
- **Phone, 390 wide:** no horizontal overflow, and the reel's control wraps onto its own row rather than crushing the ones beside it.
- **2D mode carried less than it should.** Its arrow was the field's own colour while the 3D field's arrow had taken the possessing team's, so the accessible, low-power fallback said which way the offense was going but not who they were. Fixed, and held by the 2D test.

### The recorder's clock

Found while verifying the pulse, and it had been there the whole time.

- A replay opened, the first presented world arrived before the replay bar had published the session clock, and that first sample was stamped with wall clock time. Every sample after it carried the replay's own clock, nine days earlier for a Sunday in the past, and `record()` refused all of them for running backwards. The tape drew twelve lanes reading "none" for a full afternoon with nothing anywhere to say why.
- Observed directly: twelve tracks with one sample each, stamped 9:18:06 PM, while the replay bar advanced from 6:59 PM to 7:02 PM and the cards updated normally.
- The end to end tests had been passing, because whether the first world or the first clock reading arrives first is a race. It is no longer a race: a moment with no clock is not recorded, and a sample landing before the whole recording starts the track again.
- After the fix, the same replay recorded 60 to 91 readings per game within a minute, and a pulse read "42 points of movement across 21 readings".

### The drive, on the fallback field

- The 2D field is what Reduced effects, 2D effects mode and a device with no WebGL get. It drew the markings and the ball and said nothing about the drive the 3D field had been shading since earlier in this version.
- It takes the same `DriveTrack` the 3D field and the panel take, built once by the view, so the three cannot disagree. Checked by reading the rendered SVG rather than the code: `band=1 start=1 ticks=2` for a drive two plays in.
- Held by a test that asserts the 2D field carries the drive and the possessing team, not only the markings.

### Sound, off until it is asked for

- Off by default, and the default was checked rather than assumed: with the preference untouched, a game page creates **no** oscillators at all.
- Checked on the slate too. Thirteen live cards with the preference **on** still create none, because the hook is mounted by the game page and nowhere else.
- With it on, a game page creates them. The end to end test counts oscillator constructions in the page across all three states rather than listening for a sound, which is the part automation can actually verify.
- What a play sounds like is decided in `shared/fieldSound` from the reported play alone, and four unit tests hold the parts that could invent something: a corrected, settled or reviewed play makes no sound, strength comes from reported yards and saturates at 35, and a play with nothing reported gets nothing rather than a default.
- **Not verified: that anything was audible.** No audio device was listened to. What was verified is that the nodes are created, that they are not created when the preference is off, and that they are rate limited to one every 220ms under a shared ceiling.

### The one thing that could not rewind

- **The provider's payloads were read before deciding anything.** Both odds shapes, the pregame event and the summary, carry `open` and `close` for moneyline, spread and total, and no `live` or `inPlay` field anywhere. In-game book lines cannot be read from this provider, so this is not something that could be fixed by reading harder.
- What could be built is the capability: Gridiron records the line it is told, stamped with when it was told, and rewinds that record to a play exactly as the exchange price does. The exchange's history comes from Kalshi's own candle endpoint, so there was no "write down what we saw" machinery to copy and this is new.
- **29 unit tests** hold the record end to end, from the reading through to what the panel draws. Both sides of every market are recorded rather than one side and a sign, so the record can reproduce the table it came from without assuming the book was symmetric; a reading identical to the last one returns the very same object, so a poll that brought no news re-renders nothing; a change in the juice alone is a new reading; the record is capped at 240 points and drops the oldest; a reading taken after a play is never used for it; and a play with no wall-clock time, a game with no record and a play before the record begins each get nothing rather than a guess.
- **The panel was checked by rendering it**, not by reading the code. At the second play of a two-point record it reads "As reported 5 min before this play" over `−6.5 −115` with `Was −3.5 −110` beside it, `+215` with `Was +155`, and `O 45.5 −110` with `Was O 47.5 −110`; at the first play it reads the opening figures with no "Was" anywhere, because there was nothing before it. With no play being looked at, the book's own opening and latest table is back.
- **Nothing is recorded in the replay lab**, and an engine test holds it: a replay's plays are stamped with the original Sunday while a reading taken now carries today, so a record kept there would stand after every play and describe none. This is why the replay lab still reads "Opening and closing lines, not play by play", which is the honest sentence for it.
- **Not verified: a line actually moving during a live game.** No game was in progress. The recording was driven through the engine with a provider whose line was changed between polls, which exercises the same path a live day does, and the reading was driven through the rendered panel. What has not been observed is a real book moving a real line while Gridiron watched.

### A crash that only appeared under load

- Two end to end journeys failed in a full parallel run and passed alone, which looked like the contention the last two flakes turned out to be. It was not.
- The failing page was showing the error boundary. The minified message was React error #310, which is "rendered more hooks than during the previous render", from the game page.
- The cause was mine, from the sound work in this version: `useFieldSound` had been placed beside the field it belongs to, below the page's early returns for an invalid address, a buffering replay and a missing game. A render that took one of those paths never called it, and the next render that got past them called one hook more than the last.
- It needed a game page to render one of those states first and then resolve, which is a race that parallel workers lose and ordinary use usually wins. Reproduced by running a probe four times in parallel: one of the four hit it.
- Moved above every return, rebuilt, and run eight times in parallel: none hit it. Every component in `src/` was then swept for the same shape, and the detector was validated against a synthetic file it was known to have to catch. Nothing else has it.

### A test that was true only for a moment

- One tape journey read the lanes for a game the provider had reported no win probability for, then switched to the slate and required that game's card to have no pulse. It failed about two runs in three.
- It was not the app. The replay was running at sixty times speed between the two reads, so a lane reading "none" could be a game that had simply not been reported twice yet, and by the time the card was checked it had been. The lane and the pulse never actually disagreed: both need two consecutive reported values, one from `tapeStats` and one from `ribbon`.
- The replay is stopped before the lanes are read now, so both facts are read at one moment. Fourteen tape journeys passed in three consecutive runs after the change.

### The line that would not move, and the endpoint that had it

- **The payloads were read before anything was written.** The scoreboard's `odds` and the summary's `pickcenter` carry `open` and `close` for moneyline, spread and total, and no `live` or `inPlay` field anywhere. That is why the line never moved during a game: while a game runs there is no closing line yet.
- **The core API has a third value.** Its odds document carries `open`, `current` and `close`, and `current` is the live one. Proven rather than assumed, on a finished game: `current` equals its close and both differ from its open, so it tracked the game and stopped. On a game yet to kick off it had already moved from the open, from `-7.5 -110` to `-4.5 -115`.
- **Read end to end against the live network**, not against a fixture: the real provider, the real endpoints, a scheduled game and a finished one. Both came back with the open and the live line on every market.
- **Held by nine unit tests** against two documents captured from the live core API, one pregame and one final. They pin that a spread is read as a line and the price on it as a price (both arrive as `american` strings, which is the mistake this shape invites), that a document whose teams are the other way round is read that way, that a document for another game is refused rather than guessed at, and that an empty or malformed one produces nothing.
- **One request per followed game per poll**, asked for alongside the summary rather than after it, so it costs no extra waiting. Never for a whole scoreboard: a college Saturday is sixty games, and a line nobody is looking at does not need reading every twelve seconds. A followed game's card gets the live line anyway, because the detail's summary is merged back into the slate.

### A line at a play, in a replay

- **There is no historical line source, and this was checked rather than assumed.** The core API's own line-movement collection exists and returns a valid empty page for every game tried, pregame and finished. There is no timestamp of any kind anywhere in an odds document: a search of the captured one for any date, time, updated or timestamp field found none. So a line at a past moment cannot be asked for, only recorded at the time.
- `scripts/capture-lines.ts` records it, using `recordLine` from `shared/lineHistory`, which is the same rule the running server uses. One recording rule, two callers, so a recording made by the script and one made by a running Gridiron are the same kind of thing.
- **Run against the live network** over five rounds on a real game: one reading written, four rounds correctly writing nothing because the line had not moved, and the file rewritten after every round so stopping it keeps what it has. It also refused a game that was already final, which is right: a reading taken after a game is over is honest about when it was taken and describes no moment in the game.
- **Seven unit tests** hold the replay half: the line at the replay clock rather than the one it closed at, the whole table both sides as the book had it then, the first reading as the opening line because that is the earliest the record can speak to, nothing at all before the first reading, the record cut at the replay clock so a replay stops where a live session would have, and nothing for a scenario nothing was recording for.
- **The captured Week 1 replays have no recording**, because they were captured before any of this existed, and the page says so rather than showing a closing line under a heading about a play. No line data was invented to demonstrate the feature.
- **Not verified: a real book moving a real line while Gridiron watched.** No game was in progress during this work. The recording was driven through the engine with a provider whose line changed between polls, and through the capture script against the live network; what has not been seen is the thing itself.

### Every game under its own sky

- **An earlier look concluded the provider reports neither a roof nor a surface. That was wrong, and the reason is worth writing down:** it was based on the captured fixtures, and both live on payloads those captures do not include. The live scoreboard carries `weather` and `venue.indoor`; the venue's own document carries `grass`. Checked across two full scoreboards on 24 September 2026: **weather on 33 of 34 games, an indoor flag on all 34**.
- **Night comes from the provider's own condition id**, because a venue's local time zone is not reported and a kickoff time in UTC does not say. Its ids 33 to 44 are the night forms of 1 to 14. This works because the reported condition is the forecast at kickoff, not the weather now, and the data confirmed it: the Thursday game kicking off at 8:15 in the evening was reported hours beforehand with condition 35, a night form, while the Sunday one o'clock games carried daytime ids.
- **Twelve unit tests** on the mapping itself, of twenty on the sky as a whole: every condition id the provider sends, each night form reading as the same weather its daytime counterpart is, an id never sent producing nothing rather than a guess, no sky at all where nothing was reported, and the light getting weaker and the air thicker as the weather closes in rather than each value being asserted on its own.
- **Seen, not just tested.** Snow over a lit field, the caption reading the provider's own words and temperature, and the replay bar saying the weather is synthetic. Two end-to-end journeys hold it: the snow scenario reports `{kind: snow, night: true, indoor: false, drops: 1100}` through the field probe and captions itself, and a game the provider reported no weather for reports no sky at all and appends nothing to its caption.
- **Not verified: real rain or real snow on a real game.** Every game on both scoreboards that day was dry, so the only way to see a sky was a synthetic scenario, which says so in its label, its description and the replay bar. The code path is the same one a real report takes; the numbers in it did not happen.
- **The shader patches assert themselves.** Each of the three anchors the weather's vertex and fragment patches rely on is checked at the point it is used and throws if three.js has changed it, because a shader patch that silently stops applying is the failure this version already had once.

### Drawing the line, and the rest of the polish

- **The book's line now has a trend beside it**, from the recording, held by four tests on the reading it draws from: a figure's readings with where it started and ended, the trend stopping where it is told to so it does not run past the play being looked at, nothing at all when the figure never moved because a flat trend claims a movement, and nothing with fewer than two readings.
- **Checked by rendering the panel**, not by reading the code: two readings produce two marks on the step line, the text reads "3 toward HOM", the trend disappears at the first play because one reading is a line and not a movement, and a game with no record draws no sparkline at all rather than a flat one. A spread of zero renders as a pick'em, forty readings render with no marks at all, and the move carries neither the up nor the down class in any case.
- **The 2D field is lit by the same sky through the same function.** `skyTint` and `multiplyHex` in `shared/sky` are the only arithmetic, used by both fields, so the fallback cannot hold a different opinion about an overcast afternoon. Held by rendering the 2D field under four skies: a storm is darker than the sun, night is darker than the sun, nothing reported leaves the exact colours it always had (`#1d5a3c` and `#21633f`), and a surface that cannot be mown loses its second green.
- **A screen reader is told what the field is lit by.** The caption under the field is hidden from screen readers because it repeats the panel beside it, so the sky was in nothing a screen reader could reach. It is in the situation panel's own sentence now and in the 2D field's `desc`, and a render test requires the sentence to be absent when nothing was reported rather than present and empty.
- **`skyLook` is held rather than re-derived.** It was being rebuilt on every render of every field, and a slate is thirteen of them.

### Measured again, at the end

- Thirteen live fields at 1920x3200 with the replay at 60x, three consecutive solo runs with nothing else on the machine: **zero long tasks in all three**, frames 1.73 to 2.93ms, 151 to 189 draw calls, heap 24 to 26MB. A game page on its own: 0.76 to 0.82ms a frame across 34 draw calls.
- **A game page in the snow**, which is the one thing on the field that never stops, because everything else is drawn on demand and a still page renders no frames at all: **0.55 to 0.62ms a frame across 36 draw calls**, two more than the same page in the dry. Sixty frames a second held over 240 consecutive frames, median 16.7ms, slowest 17.6 to 17.8ms. It is written to `docs/perf-weather.json` on every run and the suite fails if the slowest frame passes 34ms.
- The JavaScript heap read 41MB on the first run and 25MB on the two after it. The 25MB is the settled figure and the 41MB was the first run after a build; it is reported here rather than quietly dropped.
- **Several readings were thrown away rather than reported.** One taken immediately after a three minute screenshot run showed 2.63 to 5.11ms frames and three long tasks with a 238ms longest. A later batch read **39 draw calls on the game page where the truth is 34**, which looked like a regression and was chased as one: run on its own the same page reads 34 three times out of three, and the 39 was another suite sharing the machine. Twice a foreground suite and a background measurement were driving the same Playwright server at once, which failed three field tests and killed the measurement; all of them passed alone. A measurement taken while the machine is busy is a measurement of the machine, and the rule this version has used throughout is that a contaminated reading is thrown away rather than explained.

### Checks

- 564 unit tests, 59 files.
- 120 end-to-end journeys across Chrome and WebKit: 104 run, 16 skipped by their own guards, none failed. Fourteen are the tape and the pulse, fourteen are the field in 3D and the reel, and five are odds and win probability.
- **Firefox could not be run at all on this machine.** Playwright's Firefox build fails to launch with "Could not find profile folder" before any page loads, which is its install and not the app. The eight journeys tagged `@cross` that would have run there did not.
- Two tests were found flaky under a full parallel run and fixed, both for the same reason: the slate re-ranks on its own twenty second clock, so anything captured before a move is not a promise about the order after it. The J and K journey read the game id off the first card rather than off the card that had focus, and the `[` and `]` journey compared a position index captured twenty seconds earlier. Each now asserts what it actually claims: F acts on the focused card, and `]` goes to the game the navigation is pointing at, read at the moment the key is pressed. Neither is a symptom of anything in this version, and each passed repeatedly in isolation before being changed.
- Accessibility: axe-core against WCAG 2.1 A and AA on the slate, the tape, a game page, a team page, the dialogs and the not-found page, in both themes. No serious or critical violations.

### Not verified for 0.6.0

- **A live day.** The tape was recorded from the replay lab, through the same presented world a live day uses. No live card was watched end to end.
- **A full college Saturday.** Sixty lanes was reasoned about and guarded against in the code (the stagger cap, the absent `will-change`, the per source track cap), not observed. Sixty pulses were measured, but as sixty synthetic drawings built in the page, not sixty real cards on a real Saturday.
- **Firefox.** Its Playwright build will not launch on this machine. WebKit was run and passed.

## Version 0.5.2

Recorded Monday 14 September 2026, late in the evening US Eastern, during the Monday night game. It covers a period when the live deployment showed NFL and college data as unavailable, what that exposed in Gridiron, and the fixes.

### What happened

- On the deployed 0.5.1 site, the slate showed "Provider response: NFL scoreboard: HTTP 403" and "College season could not be read from the provider". Beneath those notices it said "No games on this day.", "No kickoffs found in the next seven days." and "No recent final scores found."
- HTTP 403 is a refusal: ESPN's servers declined the Vercel function's requests. Nothing in the repository or the deployment had changed. By 8:42 PM the site was reading ESPN again, with no change on Gridiron's side.
- From this Mac on the same evening, ESPN's site API answered a request with Node's default User-Agent. It refused, with 403, a request with no User-Agent and one with a User-Agent naming Gridiron, so it filters requests at its edge.
- Why it refused the deployment is not known. Vercel's logs were not available, and ESPN publishes no rules for this unlicensed API. Requests from shared cloud addresses meeting a bot rule is a likely explanation, not a verified one.
- Gridiron does not disguise its requests to get past a refusal, as the README says under Limits.

### What it exposed in Gridiron

1. **Unknown data was shown as no games.** The notices were right, but the day view, the look ahead and the look back treated a slate the provider never answered as an empty one.
2. **Failures were cached like successes.** The CDN shared a slate the provider had not answered for 10 seconds, plus 30 of stale reuse. The look ahead remembered a day it could not read as empty for ten minutes.
3. **A warm function instance kept its first answer.** Nothing polls between requests on Vercel. The engine fetched a day's slate on the first request and never again while the instance stayed warm. An instance that first read the slate during the refusal would keep answering "HTTP 403" after ESPN recovered, and a healthy one kept serving its first scoreboard.

The third was seen on the live site after ESPN recovered:

| Time (US Eastern) | Live site, `/api/slate` | ESPN's scoreboard |
| --- | --- | --- |
| 9:12 PM | NFL scoreboard last read at 8:43 PM, shown as connected | |
| 9:13 PM | Five requests in a row, each answered by the function (`x-vercel-cache: MISS`), all carrying the same 8:43 PM read | DEN at KC, 8:46 in the 2nd, 7 to 7 |
| 9:13 PM | DEN at KC at 9:21 in the 2nd. The game's own data, `/api/game/nfl-401872931`, was read on request and matched ESPN: 8:41 in the 2nd | 8:41 in the 2nd |
| 9:19 PM | Scoreboard still last read at 8:43 PM. DEN at KC at 8:41 in the 2nd, updated by that game request rather than a scoreboard read | 6:22 in the 2nd, 7 to 7 |

A viewer's cards on screen still moved, because the page also asks for each visible game every 25 seconds and the newer report wins. The day's list of games, the league notices and freshness come only from the scoreboard read. That is how a refusal could outlast ESPN's recovery.

### The fixes

- **Unknown is not empty.** `shared/availability.ts` treats a league as unknown when it is marked unavailable and has not been read successfully for that day.
  - The slate then says "Games could not be loaded." or speaks only for the leagues that answered. The summary strip names the unavailable data instead of "Nothing in progress", and the wall does the same.
  - The look ahead and look back count such a day as a failed lookup, say so, and try again after a minute.
- **Failures clear quickly.** A slate or game the provider never answered is cached for 2 seconds, with no stale reuse (`server/http.ts`).
- **Each request refreshes what is due** (`server/engine.ts`). On a serverless deployment:
  - A request refreshes a league's slate once its polling interval has passed: 25 seconds while games are live or kick off within 45 minutes, 5 minutes otherwise, and 30 minutes for past days. It refreshes a game after 12 seconds.
  - Both count as due 3 seconds early. Viewers poll on the same cycle, so a request arriving a moment early would otherwise wait out a whole further cycle.
  - A refused slate is asked for again after 30 seconds, and a failing game at most every 10, so a refusal does not bring a request on every page load.
  - A persistent Node server keeps its own timers and is unchanged.

### Checks

| Check | Result |
| --- | --- |
| Typecheck (`tsc`, strict) | Clean |
| Unit and integration tests (`npm test`) | **456 passed** in 53 files (0.5.1: 446 in 51). The new tests cover when data counts as unknown, the cache headers on a polled deployment, and a serverless engine: retrying 30 seconds after a refusal and recovering, refreshing a healthy slate on its interval, spacing requests for a failing game, and counting a healthy slate or game as due 3 seconds early |
| The 3 second allowance set to 0 | The two tests for it failed and the other three passed |
| `npm run check:serverless -- --live` | Loaded as plain Node modules and answered as version 0.5.2. Today's slate had 1 game, with Kalshi prices. DEN at KC's detail carried 67 Kalshi prices of history. TB at CIN (13 September) came back with 177 plays, 18 drives, 12 scores and 15 team stats |
| The function on a local server applying the `vercel.json` rewrite, with every ESPN request refused (HTTP 403) and then answered | While refusing, the slate and DEN at KC's game both answered as unavailable, each cached for 2 seconds with no stale reuse (`s-maxage=2`). Once ESPN could answer, a viewer polling every 2 seconds saw the slate recover 31 seconds after the refused read, cached again for 10 seconds with 30 of stale reuse. With DEN at KC live and a request every second, the scoreboard was read again 22 seconds after the previous read |
| The polled client against that server, in the browser, before the 3 second allowance was added | While refusing, the slate and the wall said games could not be loaded, with the league notices, and nothing was described as absent. After ESPN answered again the page recovered without a reload, in about a minute |
| End-to-end journeys, production build, replay mode | **67 passed** on the final code: 60 in Chrome and 7 in WebKit |
| `@cross` journeys in Firefox | **Not run.** Firefox still does not start on this machine (see Version 0.3) |

Design screenshots and performance were not recorded again. The only visual change is the wording when data is unavailable.

### Not verified for 0.5.2

- **Vercel itself.** 0.5.2 has not been deployed. Once it is, while a game is live, `/api/slate` should show the NFL scoreboard read within about half a minute of any request, not at the time of the instance's first request.
- **The CDN.** The cache headers were checked on a local server, not through Vercel's edge.
- **The refusal.** It was not seen at its source, and its start is not known; it had ended by 8:42 PM.
- **A future refusal.** If ESPN refuses the deployment again, 0.5.2 says games could not be loaded and keeps retrying, but it cannot make ESPN answer. A persistent server elsewhere, or a licensed feed, is the durable answer.

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

- **A live game.** No NFL or college game was in progress while this was built. The live sportsbook line, the recording of it and the weather at a venue were all read from the live provider and are all verified end to end against it; what has not been watched is any of them changing during a game. In-game behavior (live situations, play animation timing against real poll cadence, alerts from live plays, late-night date rollover) was verified with captured real games in the replay lab, not against a live broadcast. The first live window after the build is Broncos at Chiefs, 8:15 PM ET on 14 September 2026.
- **Browsers other than Chrome.** Safari and Firefox were not tested.
- **Real devices.** Phone and tablet layouts were checked at 390 and 768 px in Chrome's viewport, not on hardware. Touch orbit on the game page was not exercised.
- **Audio output and the browser notification prompt.** Automation checked that sound and notifications are off by default and change only through their toggles. It did not check that a chime was audible or that the OS permission prompt appeared.
- **An automated accessibility audit.** None was run; no audit tool was installed. Keyboard access, the skip link, the focus trap, Escape, focus return, the live region and reduced motion were verified.
- **The Vercel deployment.** It was not deployed (no credentials, and nothing was to be published). The serverless adapter typechecks and shares the server's code path; its behavior on Vercel is unverified.
- **Divisions II and III against the live feed.** They were verified with captured group and scoreboard data and unit tests, not requested live in this run.
- **A licensed provider.** Sportradar is documented as a seam only. No code for it exists, and nothing was tested against it.
- **ESPN stability.** The endpoints are undocumented and can change or rate-limit without notice. Gridiron reports failures instead of hiding them; it cannot prevent them.
