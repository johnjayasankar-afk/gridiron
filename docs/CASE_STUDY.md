# Four decisions that define Gridiron

The README is the reference. This is the short version of why the product is
shaped the way it is: four decisions, each with the problem it answered, what
else was on the table, what was chosen and what that cost or bought.

---

## 1. The tape draws from the middle out

**The problem.** The tape records a whole afternoon: every game a lane, the
provider's reported win probability drawn across the day. The first version
filled each lane from the bottom, the way a bar chart does, with the leader's
chance as a height.

It was unreadable in the way that matters. A game decided by the third quarter
became a solid block for two hours, and a nine in ten chance looked exactly like a
certainty. Worse, the two things a person actually wants from a day's tape are
*how close was it* and *when did it turn*, and a bottom-up fill says neither: a
game at 90 per cent and a game at 99 per cent look the same, and a lead change is
a fill crossing a line nobody can see.

**The options.**

1. Keep the bottom-up fill and add a reference line at 50 per cent.
2. Draw two stacked bands, one per team.
3. Draw from the middle out: the centre line is an even chance, and the ribbon's
   thickness is the margin.

**The choice.** The third. The centre line is the thing being measured against,
so it should be the axis rather than an annotation on one.

**The consequence.** The reading inverts, and everything gets easier. A close game
is a thin line down the centre for three hours, which is exactly what a close game
is. A blowout is a thick ribbon far from the middle. A game that turned *crosses
the middle at the moment it turned*, and you can find that moment by looking
rather than by scrubbing. The day's biggest swing became measurable because there
was now something to measure: distance from the centre, over time.

It also made the pressure track possible. With the ribbon centred, the bottom of
each lane was free, and the red zone trips went there in the team's own colour.
A lane now says who was winning and who was knocking, in one row, for nothing
extra.

---

## 2. Nothing in a lane moves

**The problem.** A tape of a Sunday is a dozen lanes, each a ribbon, a set of
quarter divisions, score marks and a red zone track. Over it run two things that
do move: the live edge, and the dot that follows the pointer as you read across
the day.

In the first version the clock and the pointer were props on the lane. So a dot
moving four pixels rebuilt every ribbon, every quarter, every score mark and every
red zone band, on every lane, sixty times a second. Reading across a finished
afternoon made a laptop's fan audible.

**The options.**

1. Memoize the lane on its data and hope the dependency list stays honest.
2. Throttle the pointer.
3. Make the lane a function of its own data and its column's width, and of nothing
   that moves. Put the two moving things outside it, as absolutely placed
   elements shifted by a transform.

**The choice.** The third. Memoizing is a promise a future edit can break silently,
and throttling makes the interaction worse to protect the drawing.

**The consequence.** The moving parts are moved by the compositor, off the main
thread. Scrubbing right across a stopped card now rebuilds nothing at all.

The part worth keeping is how that is held. A promise like "nothing rebuilds" is
exactly the kind that decays, so `e2e/tape.spec.ts` proves it instead of asserting
it: every node inside every lane's chart is tagged with an index, the pointer is
dragged across the whole tape, and then every node that comes back without a tag
is counted. The expected count is zero.

```ts
const tag = () => page.evaluate(() => [...document.querySelectorAll('.tape-lane__chart *')].forEach((n, i) => (n.__e2e = i)));
const rebuilt = () => page.evaluate(() => [...document.querySelectorAll('.tape-lane__chart *')].filter((n) => n.__e2e === undefined).length);
expect(await rebuilt(), 'scrubbing rebuilt lane drawing nodes').toBe(0);
```

A refactor that reintroduces a moving prop fails that test on the spot, with a
number rather than a judgement.

---

## 3. A line at a play needs a recording, not a source

**The problem.** Gridiron rewinds. Step back to any play and the score, the clock,
the field, the win probability and the odds all show that moment. Win probability
rewinds because the provider reports it per play. The exchange's price rewinds
because its history can be asked for after the fact.

A sportsbook's line cannot.

**What was checked, rather than assumed.** The provider's own line-movement
collection exists and returns a valid empty page for every game tried, pregame and
finished. And its odds documents carry no timestamp of any kind: a search of a
captured document for any date, time, updated or timestamp field found none.

So there is no historical source. A book's line at a past moment can only be known
if something was watching at the time and wrote it down.

**The options.**

1. Interpolate between the opening and the closing line. Rejected outright: it
   breaks the one rule the product has.
2. Show the closing line whatever play is being looked at, and say nothing.
3. Record the line as it is observed, and show only what was recorded.

**The choice.** The third, with the second's honesty where there is no recording.
The odds block says "Opening and closing lines, not play by play" while a past
play is being looked at, rather than letting a closing line be read as the line at
that moment. A scenario nothing was recording for has no line and says so.

**The consequence, and it is the biggest one in the product.** The recorder is not
a cache. It is the only copy. Which means the recording only exists for as long as
something is continuously watching, and a serverless function is not something
continuously watching: it wakes for a request and forgets. On that deployment the
line accumulates only while one warm instance happens to live, fragmented across
whichever instances answered.

So a feature decision about a sportsbook line turned into a deployment decision
about where the product should run. That argument is worked through in
[DEPLOYMENT_DECISION.md](DEPLOYMENT_DECISION.md); the recommendation is a
persistent server, and the line recording is one of two reasons, the other being
that the provider's request budget is only real inside one process.

---

## 4. The field is schematic on purpose

**The problem.** Gridiron draws a 3D field for every game, and the temptation of a
3D field is to make it look like the stadium. The provider does not report enough
for that, and it is not close. The real orientation of a stadium is not reported.
Neither is its shape, its stands, or where anybody is standing. Within a play,
routes, formations and tackle locations are not reported either, and no live
provider reports where the ball is *across* the field, only how far down it.

**The options.**

1. Model the real stadiums. Thirty two in the NFL, something like a hundred and
   thirty in FBS, and no measurements of any of them available here. A hand built
   bowl that reads as Lambeau but is not Lambeau is an invention, and worse,
   uncheckable: nobody could tell a good model from a wrong one.
2. Fill the gaps plausibly. Put the ball where it probably was, draw a route that
   fits the description, orient the field the way the stadium probably faces.
3. Draw only what is reported, say so on the field, and find an honest way to show
   the real place.

**The choice.** The third. Every field carries the line "Schematic, and which end
each team defends", because the direction is a convention here and not a fact. The
ball sits on the centre line, because no provider reports its lateral position. A
play with no reported spot says the spot is unavailable rather than defaulting to
midfield.

**The consequence.** What the field *can* say, it says exactly. Hash marks,
numbers, the try line, goal posts and pylons follow the 2026 NFL and NCAA
rulebooks, because those are facts. The bowl is sized from the venue's real
published capacity where one exists, 366 grounds of them, because that is a fact.
A venue the provider reports as indoors gets a roof, because that is a fact,
though not that roof: the provider reports that the venue has a roof, not which.

And the real place gets shown the one honest way available: its own photograph.
The game info tab carries the venue's picture, the inside of the bowl where the
provider has one, with the venue and its city under it. Twenty nine of thirty two
venues checked across an NFL slate and a college Saturday had one, and every one
of those was an interior shot.

So the product does not pretend to be a stadium. It draws a schematic of exactly
what is known, and then shows you a photograph of the real thing. That is a
smaller claim than a modelled stadium and a much more defensible one, and it is
the same decision as the line recording wearing different clothes: say what is
known, show the gap as a gap, and never fill it in.
