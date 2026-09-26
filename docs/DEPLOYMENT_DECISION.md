# Where Gridiron should be deployed

Written 25 September 2026, against 0.6.0.

## The problem

The public link serves the bounded build. [README § Deploy](../README.md#deploy) is
explicit that a serverless function cannot hold a stream open or poll between
requests, so the Vercel deployment ships without watch parties, push alerts, the
replay lab, continuous line recording and server-sent events.

Five of the most distinctive things in this project are therefore invisible to
everyone who visits it. The replay lab in particular is the single best
demonstration of the field, the tape and the reel, and it is switched off exactly
where it would do the most good.

## A correction worth making first

It is tempting to say the replay lab could be switched on for the bounded build,
because it needs no live provider. It needs no provider, and it still cannot run
there.

`ReplayLab` keeps `private readonly sessions = new Map<string, Session>()`, and
each session owns a `VirtualClock` that advances with wall-clock time. On a
serverless host:

- a session created by one warm instance does not exist on any other, and the
  client polls `/api/replay/s/{id}/status` about once a second;
- nothing advances the clock between requests, because nothing runs between
  requests.

So the lab is blocked by needing a process, not by needing a provider. Turning it
on as it stands would produce sessions that vanish between polls, which is worse
than not offering it.

There is a way to make it stateless, and it is worth recording because the design
is already most of the way there: the replay is deterministic from the fixtures,
and the client already carries `?replay=<scenario>&at=<0..1>&speed=<n>&paused=1`
in the URL. A session could be a pure function of the scenario, a start instant
and a speed, with pause expressed as an explicit `at`. That is a real piece of
work on `server/replay/`, not a configuration change, and it is not attempted
here.

## The options

### A. Move the canonical deployment to a persistent Node host

Render, Fly.io, Railway or a small VM. The repository already supports it: a
`Dockerfile`, `npm start`, and `GET /api/health`.

- **Restores** watch parties, push alerts, the replay lab, continuous line
  recording and server-sent events. All five.
- **Reduces provider load**, which matters more than the features. One process
  polls once for everyone. The bounded build fetches per request across however
  many instances are warm.
- **Makes the fetch budget real.** `GRIDIRON_FETCH_BUDGET` is an in-process
  counter. On one process it is a guarantee; on serverless it is a number per
  instance and the true ceiling is unbounded, against an upstream that has
  already answered this deployment with 403 for a period.
- **Needs** persistent storage for `.cache` (the push key pair and
  subscriptions), or the VAPID pair set in the environment instead.
- **Costs** roughly 5 to 7 US dollars a month for the smallest paid instance on
  Render or Railway, about 2 to 5 on Fly.io at 256 MB shared CPU, and 4 to 6 for
  a small VM. Free tiers that sleep are unsuitable: a polling server that sleeps
  is not a polling server. These are indicative and worth checking before
  choosing.
- **Against it:** one instance is a single point of failure, and it wants
  monitoring that does not exist yet.

### B. Vercel for the client, a persistent server behind it

The static client keeps Vercel's CDN; `/api` goes to the Node host.

- **Restores** everything, and keeps the CDN in front of the assets.
- **Costs** the same as A, since the Node host is the same, plus nothing on the
  Hobby tier.
- **Against it:** two deployments to keep in step, a cross-origin hop for every
  API request, and server-sent events through a Vercel rewrite are exactly the
  thing that did not work in the first place. It buys asset caching that a Node
  server with the cache headers it already sets does not badly need.

### C. Stay bounded, and make the bounds legible

Keep Vercel, and design the absence rather than leaving it implicit.

- **Costs** nothing.
- **Restores** nothing. The replay lab cannot be switched on without the work
  described above.
- **What it would mean:** a visible, well-made explanation of which capabilities
  this deployment does not have and why, and a link to a running full instance or
  a recorded demonstration. Some of this exists already: the empty state and the
  alert settings say what is missing, and `/api/health` reports `transport: poll`.
- **Against it:** a recorded demonstration of a live product is a poor substitute
  for the live product, and the honest explanation still leaves a visitor unable
  to see the thing being explained.

## Recommendation

**A.** Move the canonical deployment to a persistent Node host and point the
public link at it.

The deciding argument is not the five features. It is that the fetch budget
becomes true. The upstream is undocumented, has no availability guarantee, and
has already refused this deployment once. A single process that polls once for
everyone, inside a budget it can actually enforce, is a smaller and better-behaved
client than an unknown number of warm instances each with their own counter. The
features come with it.

Vercel is worth keeping as a preview deployment for the client, which is what it
is good at.

## What implementing it takes

Nothing in the code. The steps, in order:

1. Create the service on the chosen host from the `Dockerfile`, or with build
   `npm ci && npm run build` and start `npm start`.
2. Set `NODE_ENV=production`, and `GRIDIRON_TRUST_PROXY=1` behind the host's
   proxy. The host provides `PORT`.
3. Set `GRIDIRON_ORIGIN` to the public URL, so shared links carry an absolute
   `og:url`.
4. Give `.cache` a volume, or set `GRIDIRON_VAPID_PUBLIC_KEY` and
   `GRIDIRON_VAPID_PRIVATE_KEY` in the environment. Losing the pair stops every
   existing push subscription working.
5. Point the public link and the portfolio's Gridiron case at the new URL.
6. Keep the health check on `GET /api/health`.
7. Leave Vercel deployed as it is, and describe it in the README as the preview
   rather than the product.

Until step 5 happens, the public link keeps serving the bounded build, and this
document is the record of why that is a choice rather than an accident.
