# A second sport, or the argument against one

Written 25 September 2026, against 0.6.0. No code was written for this; the point
of the document is to decide whether any should be.

## What is actually football-shaped

Counted rather than assumed. Football vocabulary per module, meaning yard, down,
touchdown, scrimmage, kickoff, punt, quarter, drive and possession:

| Module | Lines | Football terms |
| --- | --- | --- |
| `server/providers/espn/normalize.ts` | 973 | 88 |
| `shared/playAnimation.ts` | 320 | 69 |
| `shared/driveTrack.ts` | 230 | 60 |
| `shared/field.ts` | 197 | 47 |
| `shared/alerts.ts` | 421 | 44 |
| `shared/model.ts` | 679 | 34 |
| `shared/replayFrames.ts` | 239 | 31 |
| `shared/fieldMarkings.ts` | 113 | 23 |

And the other end of the same count:

| Module | Lines | Football terms |
| --- | --- | --- |
| `server/engine.ts`, `server/fetcher.ts`, `server/party.ts`, `server/teams.ts`, `server/http.ts` | 1,800+ | **0** |
| `shared/tape.ts` | 327 | 6 |
| `shared/gameFlow.ts` | 193 | 3 |
| `shared/director.ts` | 106 | 2 |
| `shared/lineHistory.ts` | 173 | 2 |
| `shared/winProbability.ts` | 101 | 1 |

Two things fall out of that.

**The engine is already sport-neutral, in fact and not only in principle.** The
polling, the delta protocol, the freshness model, the fetcher's budget and
back-off, watch parties, team pages, the market layer: zero football terms across
more than eighteen hundred lines. Nobody set out to make them portable; they are
portable because the normalized model stands between them and the provider.

**The sport lives in two places, and both are the right places.** The adapter
(`providers/espn/normalize.ts`, `classify.ts`) and the field (`src/field/`, 18
files, plus the four `shared/` modules that describe what a field is). That is
what a provider boundary is supposed to look like when it works.

The brief for this document named the field geometry, the play animation, the
drive track and the markings table. That is right, and it misses two:
`shared/alerts.ts` at 44 terms is football vocabulary throughout, from touchdown
to turnover to red zone to fourth down, and `shared/model.ts` carries downs,
distance and possession in the model itself.

## The case for breadth

- **The reuse is measured, not hoped for.** A second sport would inherit the
  engine, the fetcher, the delta protocol, the freshness model, the recording,
  the tape, the director, the alerts machinery, the markets layer, watch parties,
  push, the replay lab and the whole honesty discipline. That is most of the
  repository.
- **The tape is arguably better elsewhere.** It draws the distance from an even
  chance, from the middle out. Football's scoring is lumpy: a lane is mostly flat
  with steps in it. Basketball or soccer would give it a continuous line, which is
  the shape the drawing was designed for and rarely gets.
- **A multi-sport command centre is a larger product** than a football one, and
  the recording gets more valuable the more of the day it covers.

## The case against

- **The field is the reason to choose this over a scoreboard.** Eighteen files and
  228 KB of rendering, the 2026 NFL and NCAA rulebooks in a markings table, play
  shapes derived from the reported play type, a bowl sized from the real venue's
  capacity, a roof for a venue reported as indoors. Nobody opens this instead of
  a scoreboard for the score. They open it for the field.
- **Every sport is its own provider negotiation.** Gridiron's coverage model is
  football knowledge earned slowly and not transferable: college games that
  report a score and nothing else, plays with no reported spot, a provider that
  answered 403 for a period.
- **Half-done breadth is worse than finished depth**, and this product's entire
  claim is that it finishes things.

## The question that actually decides it

Before any of the above: **does the provider report a spatial fact per event in
the candidate sport?**

For football it reports a ball spot for nearly every play, and that single fact is
what makes an honest field possible. The rule here is reported or absent, never
guessed. A sport where the free feed reports only that a basket was scored, by
whom, and when, leaves a court with nothing it is allowed to draw on it.

That is not a rhetorical question and it is not answered here. It needs one
afternoon against the candidate provider, counting how many events carry a
position, before a line of code is written. **If the answer is no, the second
sport is a scoreboard with a tape attached**, the field sits empty, and the thing
that makes anyone choose Gridiron is the thing that does not come along.

## Recommendation: depth

Not because breadth is wrong, but because the honest version of breadth is
expensive in exactly the place the product is strongest, and the evidence for it
does not exist yet.

If the spatial question is ever answered yes for a specific sport and a specific
provider, the extraction is genuinely cheap, and it is worth naming now:

1. **`shared/model.ts`** splits into the sport-neutral core, which is a game, two
   competitors, a score, a status, a clock, coverage and freshness, and a
   `FootballSituation` that hangs off it. The engine already never reads the
   football half.
2. **`shared/alerts.ts`** splits into the ranking machinery, which is neutral, and
   a per-sport vocabulary of what counts as a moment. The director already ranks
   from the neutral half.
3. **`shared/field.ts`, `fieldMarkings.ts`, `driveTrack.ts`, `playAnimation.ts`**
   become one `SportField` module implementing an interface the renderer calls:
   geometry, markings, where an event sits, how an event moves.
4. **`src/field/`** takes that interface instead of importing football directly.
   The 3D and SVG renderers stay; what they draw becomes an argument.
5. **`SportsProvider`** grows a sport tag, and the adapter directory gains a
   sibling. Nothing else in `server/` changes.

That is a real week of work, and none of it should be done on speculation.

## What depth means next

Ranked by what each would add, and every one under the same rule: reported or
absent, never modelled.

1. **Penalty enforcement as a movement.** The provider reports the penalty, the
   yardage and whether it was accepted. Today that is a line of text under the
   field. It is the one common event where the ball demonstrably moves for a
   reason the field already knows, and drawing it costs no new data.
2. **Clock management state late in a half.** Timeouts remaining are already
   drawn on the scorebug; the clock's own state, running or stopped and why, is
   reported and unused. In the last two minutes that is most of what is
   happening, and the field currently says nothing about it.
3. **Fourth-down context.** Distance, field position and the score are all
   reported and already on screen. Presenting them together as the situation they
   are needs no model and no fourth-down chart, which would be somebody else's
   model and would break the rule.
4. **Personnel and formation, where reported.** Highest ceiling and lowest
   availability. Worth a count against the live feed first, the same way the
   spatial question above should be answered: how many plays actually carry it?
   If the answer is a small fraction, it becomes a detail that appears sometimes,
   which is honest but thin.

Each of these is the same shape: something the provider already says that the
field does not yet draw. That list is short, which is a good sign about how much
of the reported data this product already uses, and an argument for spending the
next unit of effort on the tape instead.
