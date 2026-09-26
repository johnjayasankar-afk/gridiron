# Where the tape should live

Written 25 September 2026, against 0.6.0, before any of it is built. The brief for
this work asked for the escalation to be designed deliberately rather than
discovered while building it.

## What exists now

The recording is made by the browser, from the presented world, and kept in
`sessionStorage` under `gridiron.tape.v2`.

- A sample is written when something a viewer could see has changed, or when
  enough time has passed that a steady stretch still has a point to draw through.
  Neither rule is decoration: without the first a quiet game writes a sample every
  poll, and without the second a fifteen minute drive leaves a gap the ribbon
  would have to guess across.
- `MAX_TRACKS` is 60 and `MAX_SAMPLES` is 900 a game. Samples are packed before
  they are written, not stored as the objects they are in memory.
- It saves after four quiet seconds, or every twenty regardless, because a plain
  debounce never fired: thirteen games reset the timer before it could run.
- Out of quota, it removes the record and keeps going in memory. The tape still
  works for the rest of the session and simply does not survive a reload.

**Its life is one tab.** It survives a reload in that tab and dies with it. So the
tape can never show last Sunday, never compare two Sundays, and never be shared.

## The rule that governs all of this

There is already a `sourceKey` on every saved tape: the source, the timeline
epoch, and the spoiler delay in force. A recording is only ever restored into the
same source it was made from.

That field is the place the provenance rule lives, and every option below has to
extend it rather than route around it. **A recording made by this device and a
recording made by the server are different objects.** One is what this browser
happened to see, with this delay, from the moment this tab opened. The other is
what the server saw continuously. They are not interchangeable, they must never be
merged into one lane, and a lane drawn from either must say which it is.

And a gap stays a gap. A device that was closed for an hour has an hour of nothing,
and the ribbon stops rather than joining across it. That is already true and must
survive every step here.

## The three escalations

### A. Export and import a day as a file

The whole recording is already a serializable object with a `sourceKey` on it.
Export writes it with a small envelope: the version, the source key, the day, when
it was written, and by which build. Import checks the envelope, refuses a tape
from a different source, and opens it read-only.

- **Costs:** a day or so. No server, no storage API, no quota question.
- **Unlocks:** sharing, in the cheapest possible form. Also the ability to keep a
  Sunday deliberately.
- **Works on:** every deployment, including the bounded one.
- **The reason to do it first:** it turns a recording into a file, and a file is a
  fixture. Every later step becomes testable against real recorded days instead of
  synthesized ones, and the season tape can be developed before any storage layer
  exists.

### B. Local persistence across sessions, in IndexedDB

One record per source key per day. `sessionStorage` becomes a cache of the day in
progress; IndexedDB becomes the archive.

- **The size budget has to be explicit**, because this is the step where a product
  starts consuming somebody's disk. At the current caps, one day is at most 60
  tracks of 900 packed samples. A realistic NFL Sunday is 13 to 16 games and well
  under two megabytes; a college Saturday can be sixty games and several times
  that. The budget should be stated in days rather than bytes, because that is
  what a person can reason about: **keep the last N days, oldest evicted first,
  with N shown and adjustable.**
- **It needs a panel that says what is kept on this device**, listing each day, its
  size, where it came from, and a way to delete one or all of them. Not a settings
  toggle: a list of what exists. A product that quietly accumulates a season of
  recordings on someone's laptop without showing them is not this product.
- **Costs:** a few days, most of it the panel rather than the store.
- **Unlocks:** the season tape, and the tape as the midweek empty state. Both are
  impossible without it.

### C. Server-side recording on the persistent deployment

The server already watches continuously; that is the entire argument for the
persistent deployment in [DEPLOYMENT_DECISION.md](DEPLOYMENT_DECISION.md). A tape
recorded there exists for everyone, including whoever was not watching.

- **This is where the provenance rule earns its keep.** A server tape has no
  spoiler delay, no gaps from a closed tab, and covers games nobody had open. It
  is a better record and a different object, and the interface has to say so in
  words rather than a badge: "recorded by this device" against "recorded by
  Gridiron". A person comparing their own Sunday with the server's should be able
  to see both and never be shown a blend.
- **Costs:** the most, and it is the only one that adds a storage and retention
  question on the server side.
- **Blocked by:** the deployment decision. On the bounded deployment there is
  nothing watching continuously, so there is nothing to record.

## Recommended order

**A, then B, then C.**

A is cheapest, works everywhere, and makes B and C testable against real days. B
unlocks the two features that make the tape the centre of the product rather than
the fourth view. C is the best object but depends on a deployment decision that is
recommended and not yet made.

The one thing to resist is doing C first because it is the most impressive. A
server recording that nobody can export, of days nobody can compare, is a database
rather than a product.
