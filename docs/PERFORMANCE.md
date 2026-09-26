# Scrolling, and what it costs

A report of a bug that could not be reproduced, the six changes measured while
looking for it, and the harness left behind so the next person does not start
from nothing. Measured 26 September 2026 on an Apple Silicon Mac, headless
Chrome, against `npm run build` with `GRIDIRON_PROVIDER=replay`.

## The report

> When I scroll on a slate of games the fields stay fixed but the rest of the
> page moves.

Later, and this is the version that could be aimed at:

> The fields are delayed and then snap into place after.

That is a specific and plausible failure. The field canvas is one WebGL surface
fixed to the viewport, and each field is drawn into its card's rectangle with a
scissor. Rendering is on demand: nothing is drawn unless something asks for a
frame. If a scroll moves the page and no frame is drawn, the pixels stay where
they were and every field sits away from the card it belongs to.

## The number that describes it

**Pixels per redraw**: how far the page moves between two frames of the field
canvas. That distance is exactly how far a field can sit from its card. Under
about 25px it is not visible. At 60fps and an ordinary scroll it lands there on
its own, because one display frame at a normal scroll speed is about that far.

```
node scripts/scroll-perf.mjs http://127.0.0.1:8787/
```

## What it measures here

| | px per redraw | long tasks | blocked |
|---|---|---|---|
| slate, normal speed | 18 | 0 | 0ms |
| slate, CPU throttled 4x | 23 | 4 | 331ms |
| game page, CPU throttled 4x | 22 | 1 | 166ms |

At normal speed the canvas redraws about once per display frame. Screencast
frames captured mid-gesture at 1100px/s and again at 5000px/s, a hard flick,
show every field sitting inside its card with no offset.

**The reported behaviour did not reproduce**, at any speed or throttle, in this
browser on this machine. That is not the same as saying it does not happen.

## What would explain it anyway

The slate does carry real main-thread pressure under throttle: four long tasks
and 331ms blocked across three gestures, against one task on the game page. A
browser that throttles the main thread harder during a momentum scroll would
show the reported symptom on exactly this architecture, and Safari is the
obvious candidate: its momentum scrolling runs on the compositor while the main
thread is starved, and a fixed, demand-rendered canvas is the pattern that comes
apart there. Reproducing it needs the browser it happens in.

## The field that arrives late and snaps into place

This one did reproduce, once the report was precise enough to aim at: the
fields are not late, they are **missing**, and then they appear.

A mounted 3D view is an empty `div`. Its pixels come from the shared canvas,
which is fixed over the page and scissors into the view's rectangle, so between
React mounting the view and the canvas drawing a frame there is nothing in the
box. Before that, while the slot was still outside the mount margin, the render
was literally `null`. Both are holes, and on a slate that reorders itself while
you read, cards arrive in view without having been scrolled to, so the holes are
not rare.

Captured mid-scroll at 4x throttle: **four of six visible cards were empty
boxes**, each with a drive strip and a floating pill on a blank panel. The same
frame after the fix has a field on every card.

The fix is that a flat field stands in. `FieldSvg` already draws the whole field
for 2D mode, so it is the obvious floor: same spot, same yard line, same
reported ball, drawn flat. It renders on the same gate as the 3D view, both land
in the same commit, the flat one paints immediately because it is DOM, and the
3D one paints over it on the next frame. The stand-in version carries no
situation, drive or trail, since all of that is about to be covered.

It is not free. Nine interleaved rounds:

| | before | after |
|---|---|---|
| CPU 1x, px between redraws | 20 [17..24] | 24 [20..25] |
| CPU 1x, long tasks | 0 | 0 |
| CPU 4x, blocked during a scroll | 304ms | 651ms |

At the speed this runs at, the cost is four pixels more between redraws, both
sides of which are under the twenty-odd pixels where a gap becomes visible, and
neither produces a long task. That buys a field on every card instead of blank
boxes on most of them. Under a 4x throttle the cost is real, but so is the
symptom, and a machine that slow was showing more holes to begin with.

Two things measured on the way and kept out: rendering the flat field for
**every** slot rather than only mounted ones tripled the blocked time, and
cutting the stand-in down to a bare field did not recover it, so the cost is the
extra component tree rather than what it draws.

## Measuring it where it happens

Since it will not reproduce here, the app can measure itself in the browser it
is happening in.

```
open the site with ?probe=tracking
scroll the way that looks wrong
read the line in the console, or copy window.__gridironTracking
```

It prints one line:

```
Gridiron tracking: worst gap 0px, typical 0px, 52 frames per 1000px,
display 60Hz, canvas top 0px, dpr 2, 6 fields. The fields are tracking.
```

**worst gap** and **typical gap** are the distance between where a field was
drawn and where its card had got to, in CSS pixels. That is the defect, measured
directly. Under 20px is a frame of lag and invisible. Over 40px is what the
report describes.

**canvas top** should always be 0. If it is not, the canvas is scrolling with
the page instead of staying fixed to the viewport, which happens when an
ancestor gains a `transform`, `filter`, `backdrop-filter`, `will-change`,
`contain` or `perspective` and takes over as the containing block. That was
checked here and the ancestors are clean, but it is state-dependent and worth
having in the readout.

**display Hz** matters because the page scrolls at the display rate while the
fields arrive at whatever this can draw. At 60Hz drawing 55 frames a second is
invisible. At 120Hz it is every other frame, and a fast scroll puts real
distance between a field and its card.

The probe installs nothing without the flag, so it costs a normal visit nothing.
It is validated by breaking it: freeze the frame counter so the canvas looks
stopped and it reports a 1221px worst gap and zero frames per 1000px, which is
the fault it exists to catch. `src/field/trackingProbe.ts`.

## Six things measured and not kept

Every one of these was built, measured against the unchanged build with the
runs interleaved, and reverted. They are listed so nobody spends the afternoon
again.

| Change | Result |
|---|---|
| Hold the atmosphere shader still during a scroll | 24px against 25px per redraw over eleven rounds. Nothing. |
| Run the loop continuously while the page moves, instead of asking for one frame per scroll event | 51 frames per 1000px against 50, and it left the loop running for twenty frames after every scroll. |
| Drop the field resolution while the page moves | 51 frames per 1000px against 55. Both were already at 57fps, so there was nothing for cheaper frames to buy. |
| Replace the 250ms layout poller with a ResizeObserver and a MutationObserver | Nothing on a live page; the quiet-page run was bimodal and did not isolate the change. It also puts a MutationObserver over the whole body on a page that mutates constantly. |
| Pre-compile the field shaders | There is nothing to fix: programs hold at 5 across four gestures. No compile happens mid-scroll. |
| Chase a texture leak | There is none. Textures grow to 43 as views mount and then hold. |
| Tighten the 420px mount margin to cut measured views | Rejected before measuring: it trades a cost nobody sees for fields popping in during a fast scroll, which is the thing being complained about. |
| Batch the per-frame rect reads | Not attempted here; the equivalent change on the portfolio measured 9% worse, because the guard it needed cost more than the reads it saved. |

## What is actually expensive

From a CPU profile of four scroll gestures at 4x on the slate:

```
   320ms  (anonymous)              index.js
   380ms  getBoundingClientRect    across four call sites
    48ms  navigation chunk
```

`getBoundingClientRect` is the largest single cost, and most of it is not ours:
drei's `View` measures every mounted view on every rendered frame, which is how
it knows where to scissor. Ten views at sixty frames is six hundred forced
layouts a second on a page with three thousand elements. Reducing it means
either fewer mounted views, which makes fields pop in, or measuring them
somewhere other than inside drei, which means not using drei's `View`.

That is the honest end of this investigation: the next real win is in how the
views are measured, and it is a change to the renderer, not a tweak around it.

## Rules for using the harness

**Nine rounds minimum.** At five rounds it reported one change as 94% worse and
at eleven as no different at all. A live replay makes the page busy in ways that
vary; a single short run is worth nothing.

**Interleave.** Two measurements of the same build, one after the other, can
differ by a third on a busy machine. Pass two URLs and the harness alternates.

**If the ranges overlap, it said nothing.** The harness prints the spread for
exactly this reason.

**Check the thing still works.** The portfolio shipped a scroll change the same
week that measured 14% better and had quietly stopped the effect from running at
all. A measurement that improves because a feature broke looks identical to one
that improves because the code got faster. Read the result, not the counter.
