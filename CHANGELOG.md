# Changelog

## 0.6.0

22 September 2026

### New

- **The tape**, a fourth view at `/tape`, on `4`, or Tape in the layout control. The whole day on one clock: every game a lane, the provider's reported win probability drawn across the afternoon as the distance from an even chance.
  - Drawn from the middle out rather than the bottom up. Filling from the bottom made every decided game a solid block and a nine in ten chance looked like a certainty; from the middle the thickness is the margin, a close game is a thin line down the centre, and a game that turned crosses the middle at the moment it turned.
  - Pointing anywhere puts one line across every lane and reads all of them at that moment: the score each game was at, the clock it was on, where its chance stood.
  - Above the lanes, three measurements of the day: the game whose reported chance has moved most, the largest single swing anywhere and where it landed, and the game that has changed hands most often. Each names the measurement rather than a verdict.
  - **Games finishing together** is called out when two or more live games are within one score in the last five minutes of regulation or beyond. It is the one state a Sunday turns on that no single card can report.
  - The recording is written from the presented world, so it respects the spoiler delay exactly as alerts do, and each sample carries the moment it was true rather than the moment it was drawn. A replay records on the replay's own clock, so a Sunday played back at thirty times speed still draws the shape of a Sunday.
  - Nothing is fetched for it and nothing leaves the device. It is kept in session storage, so a reload during the afternoon does not throw the day away, and it is drawn in DOM and SVG, so it works identically in Full, Reduced and 2D effects modes and needs no WebGL.
  - A game whose provider reported no win probability shows no movement rather than a zero, and where values stop the ribbon stops rather than joining across the gap.
- **The pressure under the band.** A second track along the bottom of each lane shows where a team was inside the twenty, in that team's colour, with quarters drawn faintly behind the score marks. The recorder already kept both, so they are drawn in the same pass: the lane goes from "who was winning" to "who was winning, and who was knocking" for nothing. Red zone stacked up before a score mark is a drive that finished; a long bar with no mark after it is one that did not.
- **The ball is a football.** It was a scaled sphere with a bar of laces and read as a brown pill. It is a circular arc revolved about its long axis now, which is the shape a football actually is and is what gives it points at the ends, with a lace panel and its cross stitches; and because a college ball is not a pro ball, an NCAA ball carries the two white stripes its rules require while an NFL ball carries none, drawn from the same rulebook table as the hash marks.
  - On the game page a rim of light traces the ball's silhouette, drawn as the same shape a touch larger with only its back faces showing, so it appears where it reaches past the ball and nowhere else. Leather is the darkest thing on a dark field and the ball is the subject of every play.
- **The odds panel rewinds with the play you are looking at.** The provider's win probability already did; the exchange's price did not, though the record to do it with was already being drawn as a trend beside it. Stepping back to an early play now shows the price that stood when it happened, the change it made, and a trend that stops there, so the whole block is one moment instead of two. Nothing is interpolated: the price is the last one recorded at or before that play's wall-clock time, a price recorded after the play is never used because it was not known then, and a play with no reported wall-clock time gets none.
  - The sportsbook is the one thing that cannot rewind: it reports an opening line and a latest one and nothing between them. While a play is being looked at, that block now says **"Opening and closing lines, not play by play"** instead of letting a closing line be read as the line at that moment.
  - How often each of them actually moves, measured over thirty minutes of game time: the win probability took **10** distinct readings, the exchange's price **8**, and the sportsbook's lines **1**.
  - A figure lights for a moment when a new one arrives, keyed on the value so it only runs when the value changed. The number never counts up through figures nobody reported.
- **The reel: every scoring play of a game, in order, drawn on the field.** Landing on a play is deliberately a burst that draws no movement, which is right for a jump and wrong for a recap, where the jump is the thing being watched. The reel draws each score with its flight, its trail, the mark where it landed and the stands answering it, holds each for a beat that scales with the replay speed, and hands the game back to live when it reaches the end. Anything done by hand ends it. `R`, a button beside the scoring jumps, or the command palette.
  - It is the replay driver that was already there, walking a shorter list. What was missing was a way to say that a jump was deliberate.
- **Each game is played on the home team's field.** The mark at the fifty is the home team's, painted into the turf: their logo where the provider gives one, their letters in a ring where it does not. It is the same liberty the end zones already take, and it is the one thing that makes a real field that team's field; without it every game was played on the same field with different end zones. On painted turf it is ink at part strength and on the holographic field it is added as light. One texture per team and style, reference counted like the end zones, drawn at a quarter of the area on a card, where the mark is about sixty pixels across.
- **An extra point is a kick.** The provider reports that on the conversion rather than in the kind of play, so an extra point used to slide along the ground like a run and a good one lit nothing. It flies now, and one the provider called good lights the gate between the uprights like any other made kick.
- **A blocked kick never gets away.** Field goals, punts and conversions the provider says were blocked go up off the foot, are knocked back down, and are short and over quickly, instead of sliding along the ground as a run did.
- **An interception is thrown one way and taken back the other.** It was drawn as a single smooth arc from the throw to where the RETURN ended, which put the ball flying to a spot behind the line of scrimmage: not what happened. It is two legs now, in the air for the throw and carried for the return, so it spirals out and stops spiralling the moment it changes hands. Where it changed hands is not reported, so the turn is drawn just past the further of the throw and the end of the return, which is the one thing that can be said about it: the catch was beyond both.
- **The drive is on the field.** Every other view answers where the ball is; a drive is the thing the ball is in the middle of, and until now it lived only in a chart beside the field. The field shades the ground between where the drive began and where the ball is, as a ramp that is faint at the start and strongest at the ball; marks the play it began at with a dashed line, which cannot be taken for the line of scrimmage or the line to gain the way a third solid line would; and puts one mark along the near sideline for each play the provider gave an end spot for, oldest dimmest, so their spacing is the rhythm of the drive. Eight marks close together is a grind; one far from the rest is the play that broke it open.
  - It is drawn from `shared/driveTrack`, where the arithmetic already lived and was already tested. The view builds that reading once and hands it to both the field and the panel, so the two cannot disagree about a drive, and stepping through the drive replay grows the field's drive because the reading is cut at the play being watched.
  - A play the provider gave no spot for has no mark. The panel beside the field already says how many those were, and nothing here guesses a position to fill the gap.
- **A kick the provider called good lights the gate between the uprights.** It is the one moment the goal posts are the subject, and a kick that counted and one that did not drew the same ring on the grass. The gate is an open box of light rather than a sheet, because a sheet facing down the field is edge on from the broadcast camera and all but vanished at the one moment it exists for.
- **The stands answer a turnover too**, in the colour of whoever the provider says came away with the ball, more quietly and for less time than a score.
- **The ball wears the mark of the team that has it.** Possession is reported, so the field says it. On the game page the ball carries that team's logo on the two upper flanks either side of the laces, which is what an elevated camera sees; at every size the arrow and the mark on the ground take that team's colour, and they ease between colours, so a turnover reads as the field changing hands rather than only as a line of text. With no possession reported the ball is plain leather and the marks are the field's own colour, because the field does not guess who has the ball. A logo that will not load cross-origin becomes the team's letters instead.
  - One texture per team, reference counted like the end zones, and only ever built for the game page: on a card the ball is thirteen pixels and the colour does the work. It is keyed on the team rather than on the logo's address, because the provider hands out two addresses for the same picture and keying on the address painted every ball twice and fetched every logo twice.
- **The mark under the ball behaves like a shadow.** It spreads and softens as the ball climbs; it used to tighten instead, which read as a ball sinking into the turf on a deep pass. On painted turf it is now a shadow and falls away from the light, and on the holographic field, which has no sun, it stays under the ball and is light rather than dark.
- **A ball struck off the ground goes over the top.** Kickoffs, field goals and extra points turn end over end and do not spiral; punts and passes spiral. Which one it is comes from the reported kind of play, so the ball turns the way that kind of kick actually turns.
- **A play marks the spot it ended.** One quick ring where the ball arrives, widened by the ground the play covered, so a long gain lands harder than a two yard run. A scoring play has its own, larger mark and does not get both.
- **The broadcast camera moves with the play** instead of waiting for it to stop and then moving to where it ended. It pans along the field while the ball runs, keeping its own height, angle and distance and lagging a little, which is what a camera on a sideline does. A preset, a reset or a zoom takes over from it, and once the viewer has turned the camera themselves it never moves on its own again.
- **The field is lit rather than lighting itself.** Each of the four towers throws a soft pool of light on the turf, brightest under them and falling away to the corners.
- **The bowl recedes.** The stands and the crowd darken with distance from the camera, so the far side of the stadium no longer reads as bright and as sharp as the near touchline. It is two instructions and one varying patched into the materials the arena already had, rather than scene fog, which would have meant turning fog off on every material the field shares with thirteen cards.
- **`window.__gridironField`**, beside the renderer's own `__gridironGraphics`: what the field is doing, each layer writing its own part of it as it draws, read through a getter that costs a frame nothing. `e2e/field.spec.ts` reads it to hold the things about the field that cannot be checked by looking at a still, which is most of what was added here.
- **The ball carries itself the way the play says it was thrown.** A pass or a punt spirals about its long axis and its nose follows the arc it is on, up off the hand, level at the top and down into the catch. A ball being carried is tucked under an arm and does not spin at all, so the ball tells a pass from a run before the description is read. The nose angle is measured from the ball's own last two positions, so every shape gets it right without describing it, and the spin is the speed that reads as a spiral at the size the ball is drawn: a real sixty turns a second would stand still at sixty frames a second, or run backwards.
- **A play draws its own path as it runs**, instead of the path appearing once the ball has landed. An arc is revealed through its own geometry's draw range and a ground ribbon is scaled out from where the play began, so neither rebuilds anything per frame, and the ramp that brightens toward the ball is squeezed into the part that has been drawn so the head of the trail is always the bright end.
  - The arc was also being drawn at under a pixel wide on the game page and about half of one on a card, which is to say it was drawn and never seen. It is thick enough to read now.
- **The arena is a stadium.** The bowl was there all along and painted almost black, so the field floated in a void: the stands now carry a gradient shaded per vertex by height and by which way each face points, so the rows read from above and the risers stay dark from the side; a lit rail runs along the front of every tier and a line along the back of the top row, which is what makes a bowl read as a bowl; and the crowd is denser, warmer and capped in size so the near seats stop blooming into white blobs across the bottom of a broadcast shot.
- **The stands answer a reported score.** For a few seconds after a touchdown or a field goal the crowd takes the scoring team's colour and camera flashes pop through it, each seat at its own moment. It is decoration keyed to a reported score and says nothing about the real venue or the real crowd. The celebration is patched into three.js's own points shader rather than replacing it, so the whole crowd stays one draw call, and the arena is static again the moment it ends.
  - The field and the arena now read which end zone a score reached from one function, so they can never light opposite ends of the same play.
- **Clicking a moment on the tape opens it.** A point on a lane is a play on the field, so the band opens that game at the play that was live at the moment under the pointer, and the game page holds there while the live game moves on, exactly as stepping through a drive does. The recording keeps the play each reading followed, so it is the reported play rather than a guess from the clock; where the provider reported no play for that moment the lane opens the game plainly rather than inventing one. The day's biggest swing in the summary opens its own play the same way, because a swing was one play and that is the play worth seeing.
- **The day's biggest swing, from the command palette.** On any screen, and it opens the play it was, so "show me the play of the day" is one shortcut from the wall or a game page. It names the measurement and the game rather than calling it the play of the day, and it is absent rather than empty when nothing has been reported for it.
- **The pulse on every card.** The recording is not only worth a view of its own. The meter on a live card says who is ahead right now and cannot say whether that was always true, and "Ravens 17, Colts 14, Q3" is the same card whether it has been a three point game all afternoon or a rout that has just come back. Every card now carries its own lane at card size, under the odds: the same ribbon from the same recording, drawn across that game's own span.
  - It is the same drawing code as the tape, so a card and its lane can never disagree about what the day did. A test reads the movement off a lane and then off that game's card and requires them to match.
  - It draws nothing until there is something to draw: no empty box, no flat line at an even chance, no placeholder. It follows the odds preference, because it is a reading of win probability. Colour comes from the two variables the card already sets for its own team light, so it costs no colour work and follows a theme change with the card.
  - It takes a game id and nothing else, so the clock cannot reach it and a stopped game never redraws its pulse, which a test asserts the same way the lanes are asserted. At the recorder's cap of 900 readings, building the shape takes 0.7ms and laying out sixty of them takes 1.6ms.
- **The tape can be read by keyboard.** The lanes take focus, left and right step through the afternoon, shift takes a coarser step, Home and End go to its ends, and Escape hands the lanes back to the live game. Pointing at the tape is the whole of how it is read, and until now a keyboard could not do it at all.
- The tape wears the rest of the interface's material: HUD corner brackets on the day's measurements, the trailing rule every section head has, the pointer light that follows glass panels, mint numerals at night, and a lit edge on a lane that is still live. All of it is painted once and never again.
- **The drive is on the 2D field too.** The 3D field shades the drive, marks where it began and puts a tick on the sideline for each play; the 2D fallback showed the markings and nothing about the possession it was drawn for. It carries the same reading now, from the same `driveTrack`: a band that is faint where the drive began and strongest at the ball, a dashed line at the play it started from, and one tick per play the provider gave an end spot for. The fallback is what a phone on a bad connection, Reduced effects and 2D effects mode all get, and it should not be a worse account of the same game.
- **The field can be heard, if you turn it on.** Off by default and off everywhere until it is switched on in Display, where a test sound plays the moment it is. A touchdown, a field goal, a turnover, a first down, a sack, a long gain, a punt and a kickoff each have their own short tone; what a play sounds like is decided from the reported play alone, in `shared/fieldSound`, and a play the provider later corrected, settled or sent to review makes no sound at all, because it was never a moment.
  - It is mounted by the game page and nowhere else. A slate of thirteen games would be thirteen things making a noise at once.
  - It follows the same animation the field draws, so it keeps the spoiler delay, stays quiet through a burst of delayed plays, and sounds a play you step onto or watch in the reel exactly as it sounds live. A quick run of plays cannot stack: one sound every 220ms, and every tone is under the same ceiling, so a Sunday is never louder than a conversation over it.
- **Gridiron keeps its own record of the sportsbook's line.** The provider reports an opening line and a latest one with no times attached, which is two numbers and not a history, and is why the exchange's price could rewind to a play and the book's line could only say that it could not. So the line is written down as it arrives: every reading that differs from the last one becomes a point stamped with when it was seen, both sides of the spread, the total and the moneyline, up to 240 points a game. Nothing is written for a moment nobody looked at.
  - Stepping back to a play now shows the line that stood then and what it had been before, under a heading that says how stale it was: "As reported 5 min before this play". The rule is the exchange's: the last reading taken at or before that play's wall-clock time, never one taken after, and nothing at all for a play the provider gave no time for.
  - Three different things are said by three different sentences, because they are three different facts. "As reported 5 min before this play" is a reading that covers it. **"No line recorded at this play"** is a game Gridiron was watching that it had not yet been told a line for. **"Opening and closing lines, not play by play"** is a game no record was kept for, which is what the provider's own reporting amounts to.
  - Nothing is recorded in the replay lab. A replay runs on the original game's clock, so its plays are stamped with a Sunday months ago while a reading taken now carries today: writing that down would put a reading in the record that stands after every play in the game and describes none of them. A replay has no line from then because nobody was watching then, and the page says exactly that.

- **The sportsbook line moves during the game now.** It never did, and the reason was the endpoint: the scoreboard and the game summary report an opening line and a closing one, and while a game is running there is no closing line yet, so during the ninety minutes the line moves most those two payloads had nothing to say. The provider's core API carries a third value, `current`, and that is the live one. The proof is in a finished game: its `current` equals its close and both differ from its open, so it tracked the game and stopped. A followed game asks for it every twelve seconds, alongside the summary rather than after it, so it costs a request and no extra waiting.
  - Asked for only for a game somebody is following, never for a whole scoreboard. A college Saturday is sixty games, and a line nobody is looking at does not need reading every twelve seconds. A followed game's card gets the live line for free, because the detail's summary is merged back into the slate.
  - A live line that cannot be read leaves the summary's own lines standing, which is what the page did before there was one, and any figure only the summary knew is kept rather than erased.
- **A replay rewinds the book's line too, where there is a recording of it.** The exchange's history can be asked for after the fact; a book's cannot. The provider has no endpoint that says what a line was at a past moment, and its own line-movement collection exists and is always empty, so the only way a replay can ever say what the book was offering at a play is if something was watching and wrote it down. `scripts/capture-lines.ts` is that something, using the same rule the running server uses, and a replay of a game it watched shows the line that stood at the replay clock and rewinds it to any play. A scenario nothing was recording for has no line, and says so: the captured Week 1 replays were recorded before any of this existed.
- **Every game is played under its own sky.** A night game in the snow and a one o'clock game in the sun were the same picture with different end zones. The provider reports the weather at the venue and whether the venue has a roof, so the field says so: the sun is scaled and tinted by the reported condition, the sky itself fills more of the shadows as the weather closes in, the far end of the field is lost in the air in fog, and a roof is its own even light from straight above with no weather at all.
  - **Night comes from the provider, not from a clock.** Its condition ids carry their own sense of dark: 33 to 44 are the night forms of 1 to 14. That is the only honest signal available, because a venue's local time zone is not reported and a kickoff time in UTC does not say. It works because the reported condition is the forecast at kickoff: a game starting at 8:15 in the evening is reported with a night form hours beforehand.
  - **And it snows, and it rains.** One Points draw over the field, moved entirely in a vertex shader: each drop walks down its own column at its own speed and wraps back to the top, so a frame writes one uniform and nothing is rebuilt while it falls. Rain is drawn as a streak, snow drifts sideways as it comes down. Only where the provider reported rain, a thunderstorm, snow or ice, which is not most games, and never indoors. The game page only: thirteen cards each running their own weather would be thirteen of these for drops a pixel across.
  - A field is captioned with what it is lit by, in the provider's own words and its own temperature, so the light is attributable rather than a mood. Where nothing was reported the field is lit exactly as it was before there was a sky, with nothing appended.
- **A grass field is mown and a synthetic one is not.** Mowing stripes are made by a mower laying the blades one way and then the other, and an artificial surface has no blades to lay, so every field wearing them was wrong for about half of them. The provider reports which a venue has on the venue's own document, asked for once per venue and then remembered. A synthetic field is one flat weave with a seam every five yards where its rolls meet and a finer speckle; a grass field keeps its stripes; a venue whose surface is not reported keeps them too.
- **The book's line is drawn, not just recorded.** The exchange's price had a trend beside it and the book's had nothing, which was fair while the line moved twice a game and is not now that it moves during one. The sportsbook block carries its own trend from the recording: a step line, because a book posts a line and it stands until the book posts another, so the space between two readings is a line held rather than a line travelling. Every reading the book actually posted is marked on it, which is the difference between a book that moved once and one that moved eleven times to the same place. It reads "HOM by 6.5, 3 toward HOM from 3.5", and while a play is being looked at it stops there like everything else in the block.
  - Drawn only where the record has movement in it. A game Gridiron was not watching gets no trend rather than a flat one, because a flat trend says a book stood still when the truth is that nobody looked.
  - **The move is not coloured.** A price going up is good for whoever holds it; a spread moving toward a team is neither good nor bad, it is a direction, and a green or red on it would be the page taking a side the book did not.
  - A spread of zero is a pick'em and is written as one, rather than as a team favoured by nothing. The marks stop once there are more than twenty four readings, where they would be a smear across a hundred and twenty pixels and are redundant anyway: the step line already turns a corner at every reading.
- **A figure lights when the book moves it**, keyed on the value so it runs when the value changed and not when the table happened to render. It is the treatment the exchange's price already had, and it is only worth having now that there is a live line to read: before, these numbers changed twice, at the open and at the close.
- **The 2D field is lit by the same sky.** It is what Reduced effects, 2D effects mode and a device with no WebGL get, and it is meant to be the same field drawn another way rather than a lesser one. Its turf, its surround and its end zones are multiplied by the sky through the same arithmetic the 3D field uses, from one function, so the two cannot hold different opinions about what an overcast afternoon looks like. It drops its mowing stripes on a surface that cannot be mown, for the same reason.
- **A screen reader is told what the field is lit by.** The caption under the field is hidden from screen readers because it repeats the situation panel beside it, and the sky was only in that caption. It is in the panel's own sentence now, and in the 2D field's description: "Reported at the venue: Snow · 19°F."
- **A synthetic test scenario for the weather**, because no captured replay has any: the weather lives on the live scoreboard and was not captured with these games. It puts snow after dark on a grass field at a real game that was played in the dry, says so in its own label, in its description and in the replay bar, and is the one way to see a sky, photograph one or test one.

### Fixed

- **The game page could fail to render at all, and show "This view could not be shown." instead.** The hook that plays the field's sounds was placed beside the field it belongs to, which is below the page's own early returns for an invalid address, a buffering replay and a game not in the slate yet. A render that took one of those paths called one hook fewer than the render before it, and React counts hooks: the next render that got past them threw, and the error boundary caught it. It only appeared when a game page rendered one of those states first and then resolved, which is why it showed up under parallel load and not in ordinary use. The hook sits with the other hooks now, above every return. Every component in `src/` was swept for the same shape; this was the only one.
- **The 2D field said which way the offense was going but not who they were.** Its arrow was the field's own colour while the 3D field's had taken the possessing team's, so the fallback carried less than the thing it falls back from. It carries the team now, from the same reading.

- **Team logos flicked between two images every few seconds.** The provider does not put the same fields on a team in every payload: a scoreboard carries no logo variants at all, while the richer reports carry a dark one. Merging two reports of a game kept the lines, the venue and the market when the newer one left them out, but took the teams wholesale, so each poll erased what the other had found. On the slate that was **thirty changes in twenty five seconds** across twenty six logos, each one reloading its image. A team's branding, which is what a team IS, now survives a report that does not carry it; a rank and a record still do not, because a team can fall out of the rankings and a report saying so must be able to.
- **A logo is never sat on a light disc.** The disc was there for a team whose dark logo variant was missing, and because the variant came and went with each report, so did the disc. With the branding kept, the dark variant is used from the moment it is known, and the disc is gone.

- **Field controls were underneath the field.** Game cards wore the full glass material, whose backdrop filter forms a stacking context, and every card contains a field slot whose controls are meant to sit above the one shared WebGL canvas. They went under it instead. Cards wear flat glass now: the same tint and rim without asking the compositor for a backdrop, which is what that material is for and what the small, numerous, moving pieces are meant to wear. It also spares the compositor thirteen backdrop filters over a canvas that is redrawing.
- **Section headings were unreadable until scrolled to.** Headings were revealed word by word, which left the ones below the fold sitting at six per cent opacity until an observer fired: an accessibility audit read that, correctly, as text at 1.37 to 1. The reveal is a landing page flourish and this is a live scoreboard, so it is gone. The glass material stays.
- **The quiet text failed contrast in the Day theme.** `--tone` was 4.22 to 1 on paper, and the eyebrow that wears it is 11px at weight 500, which WCAG measures against 4.5. It is 4.73 now.
- **A replay could record nothing at all, silently.** The replay's clock belongs to the session and the bar publishes it on its own poll, so for the first moment after a replay opened there was no clock and that first sample was stamped with wall clock time: today. Every sample after it carried the replay's own clock, which for a Sunday in the past is days earlier, and the recorder refused all of them for running backwards. The tape drew twelve lanes reading "none" for a whole afternoon and nothing anywhere said why. It is fixed at both ends: a moment with no clock is not recorded at all, which costs one reading, and a sample landing before the whole recording now starts the track again rather than refusing every sample that follows it. A sample landing inside the recording is still dropped, because that is jitter in reading the clock rather than a new one.
- The accessibility audit covers the tape in both themes.

### Improved

- **A lane is drawn once and then left alone.** A lane's drawing is a function of its own data and its column's width, and of nothing that moves. The clock and the pointer used to be props on it, so a dot moving four pixels rebuilt every ribbon, quarter, score and red zone on the page, sixty times a second, for every lane. The live edge and the scrub dot are two absolutely placed elements moved by a transform now, which the compositor does without the main thread. Scrubbing right across a stopped card rebuilds nothing at all, which a test asserts by tagging every node in every lane and counting what comes back new.
  - Neither mark carries `will-change`. It would pin two compositor layers per lane, and a Saturday card of sixty lanes is a hundred and twenty of them held for a 1.5px line and a 7px dot.
  - The entrance is one shot, on transform and opacity, stepped per lane and capped at twelve steps, so sixty lanes never leaves the last one waiting a second and a half to appear. It is off under Reduced and 2D effects and under the device's reduced-motion setting.
- **Measured after all of it**, production build, thirteen live fields at 1920x3200 with the replay at 60x: **zero long tasks in three consecutive runs**, frames 1.73 to 2.93ms, 151 to 189 draw calls, and a JavaScript heap of 24 to 26MB against 34MB at 0.5.2. A game page on its own holds 0.76 to 0.82ms a frame across 34 draw calls. Readings taken while screenshot suites or a dev server were running alongside were worse across the board, and one of them read 39 draw calls on the game page where the truth is 34; every one of them was discarded and measured again with nothing else on the machine, because a measurement taken while the machine is busy is a measurement of the machine.
  - **Weather is the one thing on the field that never stops.** Everything else is drawn on demand and a still page renders no frames at all; snow falling has to keep asking for them. A game page in the snow renders continuously at **0.55 to 0.62ms a frame across 36 draw calls**, two more than the same page in the dry, and holds a steady sixty frames a second: 240 consecutive frames at a median of 16.7ms and a slowest of 17.8ms. It is measured on every run rather than assumed, because it is the one layer that cannot go quiet.

- **A lighter start.** The tape's code loads on first use like the game page's does, so it is not in the first load at all. The main bundle is 359 kB (115 kB gzipped), smaller than 0.5.2's, and the tape is an 11.7 kB chunk (4.5 kB gzipped) fetched once the page is idle. The pulse and the palette's swing are not split, because they are on the slate and in the header: with the play each reading follows, they are the 0.8 kB gzipped the startup bundle grew by. The recorder is not deferred: it has to be running from the moment the page is, or the tape would only begin when somebody looked at it.

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
