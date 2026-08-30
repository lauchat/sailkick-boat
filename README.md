# sailkick-boat

> ## ⚠️ Project status: alpha
>
> An offline webapp and mobile app for boat metrics, with weather, climatology and
> basic routing. Add a sailkick account and you also get real-time cloud sync of those
> metrics, polars, and an optional public page — so others can follow the boat, or you
> can check on it while you are away.
>
> **Registration is free, and invite-only.** I'm looking for courageous early testers:
> if you would like to try the plugin, email **[info@sailkick.io](mailto:info@sailkick.io)**.
> Self-hosters can point it at their own sailkick server and InfluxDB v2 instead — see
> [Config](#config).
>
> Expect breaking changes while the version is 0.x.

One Signal K plugin doing four jobs, each independently toggleable — so the boat stays
"just SignalK + plugins". They are deliberately separate modules: a fault in the cache
must never wedge the data-critical sync path.

**1. Data out — telemetry and AIS to the cloud.** Gapless store-and-forward of this
vessel's data into your sailkick account, so the cloud holds your history and (later)
can analyse it. Buffered on disk, so an offline passage or a restart loses nothing.
Locally-received AIS targets go up too, letting you see the boat's surroundings from
shore.

**2. Data in — the app and its maps, cached for offline.** An offline-first mirror of
the sailkick host: fetch once online, serve from disk forever. Charts, terrain, the app
itself. Plus a worldwide base map seeded on start and an on-demand download of the area
around the boat, so a usable chart exists before you lose connectivity — not only where
you happened to browse.

**3. Live data, served by the boat itself.** Caching alone would leave you offline with
a dead app: no position, no instruments, no trends, no AIS, and a login wall. So the
boat *answers* the app's live contracts from its own SignalK — `/ws/telemetry`,
`/api/history/{series,track}`, `/api/ais` — and serves `/api/config` with the cloud
login disabled. Same JSON the cloud returns, so the browser cannot tell the difference.

**4. Backfill — an existing InfluxDB archive into the cloud.** If the boat recorded
into its own database before it ever synced (a `signalk-to-influxdb-v2` bucket, or an
imported logbook), a one-time resumable copy lifts that history into the cloud where the
app can reach it.


# 1 · Data out — telemetry and AIS to the cloud

## Telemetry sync — gapless by design
Every value on `vessels.self` is batched, written to a durable on-disk spool as one
atomic file, and only then uploaded. A file is deleted **only** after InfluxDB
acknowledges it with a `204`, so an offline stretch or a Signal K restart simply leaves
files to send later — nothing is lost in the gap.

- Network errors, `429` and `5xx` are retried with backoff (1 s → 60 s); the data stays
  on disk.
- **Responses are decoded and checked for completeness.** Core `https` does neither, and
  `fetch` did both silently: the upstream serves terrain tiles pre-compressed with
  `Content-Encoding: gzip` whether asked to or not, so for one release the mirror cached
  gzip bytes labelled as terrain and Cesium read the gzip header as a vertex count
  ("Invalid typed array length: 11239580910"). A body shorter than its `Content-Length` is
  now rejected too — tiles are pinned once written, so a truncated one would be served for
  ever.
- **All cloud traffic uses core `https`, not `fetch`** — telemetry sync, the offline
  mirror, the cache-manifest poller, the contract check, the backfill and the Sync page
  share one connection pool (`lib/net.js`), so one reset clears every subsystem. Twice in one afternoon this boat's
  Signal K process stopped being able to open *any* outbound HTTPS connection — zero
  sockets to `:443`, while a second process in the same container reached the same host
  in under a second — and it never recovered on its own. Starlink sits behind CGNAT,
  which drops idle NAT mappings without an RST, so a pooled keep-alive socket looks alive
  to the client and is dead on the wire. `fetch` offers no supported way to reset its
  pool from a plugin. Owning an agent means the pool can be rebuilt after repeated
  transport failures (and it is, automatically, after five), and it means the log names
  `ECONNRESET` or `ETIMEDOUT` instead of `fetch`'s uniformly useless "fetch failed".
- A malformed batch (`4xx` other than the three below) is quarantined to `spool/dead/`
  rather than retried forever, because it would otherwise wedge the queue behind it.
- **`404`, `401` and `403` are held, not quarantined.** A missing bucket or a rejected
  token rejects *every* batch identically, so quarantining would pour the whole telemetry
  stream into `spool/dead/` while the plugin looked busy. Instead the spool is left
  intact, the status line names the setting to fix, and retries continue slowly so a
  correction recovers on its own.
- The buffer is bounded (500 MB). On overflow the **oldest** files are dropped and
  logged — a long-offline boat fills its own disk otherwise.
- Timestamps are nanosecond-precise, so replaying after a reconnect overwrites rather
  than duplicating. Re-sending is always safe.

The destination is fixed at `https://sync.sailkick.io` and cannot be changed from the
config page — a wrong endpoint here is invisible, since telemetry piling up in the spool
looks exactly like a normal offline backlog. See
[Troubleshooting](#troubleshooting-is-telemetry-actually-leaving-the-boat).

## Uploading AIS targets
The cloud app already draws other vessels, but its AIS source polls a SignalK server over
the LAN and keeps everything in memory — which cannot work once a boat is on a mobile
link. Enable **Upload AIS targets** and the boat pushes what its own receiver hears, so
the web app can show other boats, their heading and their trail from stored data.

Only **locally received** AIS is forwarded. A boat running an internet feed such as
`signalk-aisstream` would otherwise spend uplink bandwidth sending data the cloud can
fetch directly from the same API — known feeds are skipped automatically. The plugin logs
the AIS sources it sees, so you can name your own receiver in **Only this AIS source** if
you want to be explicit.

There is no radius or rate limit: a real AIS receiver is bounded by VHF line-of-sight,
which is the honest limiter, and offshore — where this data is most valuable, because
commercial feeds are blind there — it tends to zero. Vessel identity (name, dimensions,
ship type) repeats every few minutes and never changes, so it is re-sent at most hourly;
positions are never throttled.

Telemetry always wins the link. AIS buffers in its **own** spool with its own cap and
stands down completely whenever the telemetry spool has a backlog, so a busy anchorage
can never delay or evict your own boat's data.

> ⚠️ **Requires a cloud that filters history on `self`.** Every AIS row is tagged
> `self=false`, and the cloud's Trends and track queries must filter `self == "true"`.
> Without that, other ships' speed and heading appear in *your* charts. Leave this off
> until the server side is in place.


# 2 · Data in — the app and its maps, cached offline

## Proxy: how it works
```
laptop -> http://<boat>:3000/plugins/sailkick-boat/p/<anything>
       -> on disk?  yes -> serve            [X-Sailkick-Cache: HIT]
                    no  -> fetch <sailkickUrl>/<anything> -> store -> serve   [MISS]
                    no + offline -> 504
```
Any content-type (tiles, JSON, app assets). Query strings cache separately.
Open the sailkick app *through* the proxy and every relative URL it loads is
cached automatically. `POST /plugins/sailkick-boat/prefetch` with
`{"paths":[...]}` warms a region/app-shell ahead of a passage.

## Cache freshness — pinned tiles, auto-refresh on new bakes
Tiles are **pinned**: once cached they're served from disk forever (online or
offline), never time-expired — so a big tile store never "goes slow." Freshness
comes from the cloud **announcing bakes**, not from a clock:

- The cloud publishes a small manifest (default `GET /api/cache-manifest`):
  ```json
  { "app": "2026-07-19a",
    "bakes": { "tiles/osm-standard": "v3", "tiles/seamap": "2026-06", "terrain": "2026-01" } }
  ```
- The plugin polls it (only when online; a failed poll is a no-op). When a
  dataset's id **changes**, files in that family older than the announcement are
  refreshed **lazily** — refetched on next view when online (`X-Sailkick-Cache:
  UPDATED`), served stale when offline (`STALE`). Untouched tiles never re-download.
- First sight of a family does **not** invalidate — your pre-populated store is
  trusted. Only genuine bake changes refresh anything.

`X-Sailkick-Cache` reports `HIT` / `MISS` / `UPDATED` / `STALE` / `LIVE` per response.

**The app itself is never pinned.** `/`, any `index.html`, the web manifest and `/health`
are fetched fresh whenever online. They are the only files whose URL does not change
between deploys — everything they pull in is content-hashed (`main-Cm1RhM4y.js`), so a
fresh shell drags in a new build as ordinary cache misses, and the old hashed files just
sit there harmlessly. Pin the shell instead and the boat stays on whatever build it
cached first, forever. Offline the last-seen shell is served as `STALE`, so the app still
opens with no uplink.

**Static vs dynamic — two strategies.** Tiles and app assets are **cache-first**
(pinned, offline forever). Dynamic `/api/*` data (AIS, weather, lightning) is
**network-first**: fetched live every time online (so it never goes stale), with the
last response kept only as an **offline fallback** (`STALE`). Local `/api/history` and
the patched `/api/config` are served specially (above).

**Exception — velocity tiles are pinned.** The app serves its wind/current field from
`/api/velocity/tiles/<layer>/<runId>/<z>/<x>/<y>/<hour>.f32`. The forecast **run id is
in the path**, so a URL's bytes never change — a new run means new URLs. Those are
cache-first like map tiles: each tile downloads once instead of on every pan, and the
wind particles + storm field keep rendering **offline**. The velocity *manifest*
(`?run=latest`) stays network-first, or the boat would pin itself to a stale run
forever. Nothing prefetches velocity tiles yet, so offline wind covers only what you
have panned over, and old runs are not pruned.

**Offline circuit breaker.** Some boat routers return errors (or hang) for outbound
requests when the uplink is down, instead of failing cleanly. Once a fetch fails, the
mirror marks the upstream down for a short cooldown and **fast-fails uncached
requests** (no per-request timeout hang) — so a handful of uncached tiles can't
starve the browser's ~6-connection pool and block the cached tiles. Cached `HIT`s are
never affected; a single success clears the breaker.

Manual force-refresh (no SSH):
```
POST /plugins/sailkick-boat/cache/clear                            # default keep: tiles,terrain,history
POST /plugins/sailkick-boat/cache/clear?keep=tiles,terrain,history # refresh app shell; keep tiles + ring log
POST /plugins/sailkick-boat/cache/clear?prefix=tiles/seamap        # nuke one tileset
```
(The persistent history ring log lives under `<dataDir>/history`, so keep `history`
when clearing — the default keep already does. A hand-typed `find` clear should add
`! -name history` alongside `! -name tiles ! -name terrain`.)

**A pinned file that was cached wrong stays wrong.** Tiles have no expiry, which is the
whole point — but it means a bug in the *transport* outlives its fix. The pre-0.23.9
client stored still-gzipped bytes as if they were the payload (core `http` hands back the
compressed stream where `fetch` decoded it), and Cesium read the gzip header as a vertex
count: `Invalid typed array length: 11239580910`. Fixing the transport fixed new fetches
and nothing else: 2,391 terrain tiles and 188 vector tiles kept throwing for weeks after,
because nothing ever re-examined a stored file.

So a cache HIT is now checked — two bytes of a buffer already read. A file that claims to
be quantized-mesh or protobuf and begins `1f 8b` is dropped and re-fetched (`REPAIRED`);
if the upstream is unreachable the request FAILS rather than serving the poison again,
because a renderer handed a gzip header errors hard while a missing tile simply falls back
to its parent. Content that is legitimately gzip — a `.gz` asset, a gzip content-type — is
left alone: that is a payload, not an encoding.

## Offline map coverage — global base seed + region prefetch
On-demand caching only holds what you browsed. To make a usable map exist offline
*everywhere*, the plugin seeds a worldwide low-zoom base on start and lets you warm a
passage area on demand.

- **Global base seed** (default on): caches two worldwide layers, pinned forever —
  **coastline** (sparse vector `.pbf`, parent-guided descent so it probes ~4× the real
  tiles, not a full pyramid) and **seabed/bathy** (dense depth raster). Defaults
  `coastlineMaxZoom 8` (~12k tiles) + `seabedMaxZoom 6` (~5.5k). Idempotent (re-runs
  hit cache only) and self-throttling — it reuses the circuit breaker, so it goes quiet
  offline and resumes when back online. Progress shows in the plugin status line.
  Config: **Download a worldwide base map on start** (`seedEnabled`); zoom levels and
  concurrency are constants (hand-editable as `proxy.seed.*`).
- **Download around the boat** (settings dropdowns, no token) — the easiest way to
  cache a passage area: in Plugin Config pick a **Radius around boat** (25/50/100/200 nm)
  and a **Detail level** (Overview z12 … Harbor z15), then save. The plugin reads the
  boat's current position from local SignalK, builds a box, and warms the chart layers
  in the background (progress in the status line). Idempotent; re-saving tops up. An
  oversized radius+detail is refused (reduce one). Config `prefetchRadiusNm` / `prefetchDetailZoom`.

  **Each layer is clamped to the zoom it actually publishes**, read from the upstream's
  `/api/assets` (with a built-in fallback so it still works offline). Coastline tops out
  at z13 where osm-standard reaches z19, so asking for "Harbor (z15)" fetches osm, seamap
  and bathy to 15 and coastline only to 13 — instead of spending ~23% of the budget on
  coastline tiles that can only 404. Those refusals also counted toward the cap, so a
  request could be turned away for tiles that were never there.

  **What fits under the 150k cap** (four layers, mid-latitude, from z6):

  | radius | z12 | z13 | z14 | z15 |
  |---|---|---|---|---|
  | 25 nm | 1.1k | 4.1k | 12.5k | 46k |
  | 50 nm | 4.1k | 15.3k | 48k | 179k ✗ |
  | 100 nm | 15.5k | 60k | 192k ✗ | 715k ✗ |

  So **50 nm at z14** or **25 nm at z15** are the practical maxima. A refused request
  pre-warms *nothing* — check the status line rather than assuming coverage exists.

**Resolution is only limited when pre-warming.** On-demand caching has no zoom ceiling:
whatever the browser requests while online is stored and served offline afterwards, up to
the upstream's own maximum (z19 for osm-standard, z18 seamap). Browse a harbour approach
once with a connection and it is yours. Pre-warming is capped at z15 by the settings
dropdown — 3.5 m/px, ample for coastal work but coarser than the z17–18 you might want
alongside a berth.
- **Region prefetch (API)** — for scripted/arbitrary boxes, warm the detailed chart layers for an area:
  ```
  POST /plugins/sailkick-boat/prefetch/region
    { "bbox":[w,s,e,n], "minZoom":8, "maxZoom":15,
      "layers":["osm-standard","bathy","seamap","coastline"] }
  ```
  Enumerates the bbox×zoom×layers rectangle and warms it. It **estimates first** and
  refuses > 50k tiles unless you pass `"force":true` (so a huge box can't run away over
  the link). Returns `{requested,cached,empty,failed}`.
- **Empty tiles** (sparse coastline/seamap) are **negative-cached** (`.404` sentinel), so
  offline they read as "empty" (404) exactly like online instead of stalling.

Note: the app's **Coastline** and depth layers are default-off toggles — enable them in
the app to see the seeded base.


# 3 · Live data, served by the boat

## No login on the boat (single-tenant)
The cloud app gates behind a boat-account login (a `Secure` session cookie), which
can't work over the boat's plain-HTTP offline mirror — the browser drops a `Secure`
cookie on HTTP, so login just loops. Since the boat is single-tenant and its data
endpoints aren't server-gated, the proxy serves `/api/config` with `auth.required`
forced to `false` (and `historyAvailable` forced on when history is served locally),
so the boat's own app opens with no password, fully offline. Everything else in the
config passes through untouched. (Hand-edit `proxy.openAccess: false` to keep the cloud
login gate — there is no toggle, since the gate cannot complete over the mirror anyway.)

It also fills in **`boat.perfKey`**, which the cloud only sends to a logged-in session.
Without it the app has no identity and the **performance data cloud** — the recorded
(TWA, STW) samples behind the polar plot, baked to `/perf/<perfKey>/estimate.json` — never
loads, even though the bake itself is cached and reachable. The key is derived rather than
configured: the app server takes a boat's Influx bucket and its perf directory from the
same identity, so the bucket minus its `_raw` suffix *is* the perf key, for a UUID account
and a grandfathered slug one alike. An unpaired boat has no bucket, so `boat` is left
exactly as the cloud sent it.

## Routes, polars and settings — stored on the boat
The app reads and writes these through `/api/profile/*`. On the cloud that router is
session-gated, and the mirror can never satisfy it: the caching GET path forwards no
headers at all, and the browser is on the boat's LAN origin so it holds no cloud cookie
to forward either. Every call returned **401** — the route panel showed nothing, saving a
route failed, and the mobile route-weather deck silently fell back to "Dead reckoning".
Offline it was a 504.

So the plugin serves `/api/profile/*` itself, from `profile.json` in the plugin's data
directory (atomic writes, saves serialized so a burst from the route panel can't clobber
itself). Same envelopes as the cloud, so the app can't tell the difference — and route
planning now works with no uplink at all, which is when you actually want it.

**This copy is boat-local.** A route saved on board stays on board; a route saved in the
web app stays in the cloud. They are not reconciled in the background — but you can copy
either way, item by item, from the **Sync polars & routes** page in the Signal K Webapps
menu.

### Sync page — copying polars and routes to and from the cloud

Sign in once with your sailkick account and the page lists polars and routes on both
sides, marking each **in sync**, **differs**, **boat only** or **cloud only**, with a
button to copy it either way. Nothing is deleted, and an item that already exists is only
overwritten after a confirmation.

The plugin holds the session, not the browser. That is what makes this possible at all:
the cloud session cookie is `HttpOnly; SameSite=Lax; Secure`, and the boat serves the app
over plain HTTP on a LAN address — a browser will not store a Secure cookie on an http
origin, will not send a Lax cookie cross-site, and blocks an https page from fetching http
at all. Those are all *browser* rules; the plugin is an ordinary HTTP client talking https
to the cloud, so none of them apply, and the browser only ever talks to the boat.

**Only the session is stored, never the password** — it buys a session and is discarded.
The session lasts 30 days, after which the page asks you to sign in again. The endpoints
live on the plugin's own router, which sits behind Signal K's security, rather than on the
open mirror port where anyone on the boat's wifi could use them.

Items are matched by **name**, since ids are assigned independently on each side. So a
polar you refined in the web app appears as *cloud only* — or *differs* if the boat has an
older one of the same name — and one click brings it aboard.

## Live polar performance, computed on board

The plugin computes **percentage of polar target** (boat speed ÷ what the polar says you
should be doing) and emits it as two ordinary SignalK deltas:

```
performance.polarSpeed        target boat speed, m/s
performance.polarSpeedRatio   achieved / target, 0–1
```

Because they are deltas, everything downstream gets them for nothing: telemetry sync
forwards them to the cloud through the same store-and-forward spool as every raw channel
— so an offline passage replays them **gapless** rather than leaving a hole — NMEA
displays and other plugins can read them natively, and the local history ring records the
rounded percentage as a `perf` channel for offline Trends.

The maths is **vendored verbatim** from the app (`shared/engine/perf-live.js` and the pure
`Polar` evaluator), each file carrying its upstream commit and sha256. There is one
definition of "the %" — the boat and the screens must not quietly disagree — and
`test/perf.test.js` replays the upstream test suite against the vendored copy to prove it.
Fix the maths upstream and re-vendor; never edit the copy.

**Nothing is emitted unless the guards pass.** In irons (inside the no-go angle), under
2 kt of wind, or against a near-zero target, the channel simply stops. A gap is the honest
representation; a zero would be a lie that drags down every average drawn over it.

**No paddlewheel?** The percentage falls back to SOG, which the screens do too — but SOG
is polluted by current, so the status line says `(from SOG — current-polluted)` rather
than presenting it as a through-water figure.

**Polar staleness.** The percentage is computed against whichever polar the boat has. If
you refine your polar ashore, the boat keeps using its own copy until you bring it across
on the **Sync polars & routes** page — this is a manual copy, not background sync. And a
catalogue polar has to have been fetched at least once while online before it can be used
at all. The raw channels are always recorded regardless, so the cloud can recompute the
history if the maths ever changes: the recorded channel is a materialisation, not the only
truth.

## Alerts and alarms, evaluated on board

Rules — anchor drag, wind over or under a threshold, a big wind shift, boat speed below
polar — are evaluated **here**, in the SignalK process, against the boat's own bus. That
is the point: the case this exists for is the anchor dragging at 3am with the phone in
airplane mode and no uplink, which a cloud watcher cannot help with.

The rule **evaluator** is vendored verbatim from the app (`shared/engine/alerts.js`, with
its commit and sha256 in the header), exactly as the polar maths is. One definition of
"has this rule fired", or an alarm means one thing when the boat notices and another when
the cloud does. `test/alerts.test.js` replays the upstream suite against the vendored copy
— flapping, wrap-around, anchor swing, data gaps, the position-source conflict and the
two-clocks contract — and pins the boat-side host as well.

**Delivery is SignalK notifications**, which is what makes this worth more than another
screen: an alarm panel, a chart app or a Node-RED buzzer flow already listens to them.

```
notifications.navigation.anchor    anchor drag  — state "alarm",  method visual + sound
notifications.sailkick.<ruleId>    everything else — state "alert", method visual
```

Only anchor drag takes a conventional path: a boat has one anchor, so it cannot collide,
and it is the rule other software reacts to. Wind rules get a path of their own per rule,
because "over 30 kt" and "under 5 kt" are two rules a sailor plausibly sets at once, and
one shared path would make each transition overwrite the other's state. Clearing is
`state: "normal"`, per the schema — the path is never deleted. A rule may carry its own
`state`/`method`, validated against the SignalK enums (`nominal|normal|alert|warn|alarm|
emergency`, `visual|sound`).

**Alarms reach the cloud through the telemetry spool.** A transition is written as one
row of Influx line protocol and handed to the same store-and-forward buffer as every other
channel, so it inherits what that buffer was built for: ordered, gapless, nothing lost to
a failed POST or a restart, and an alarm raised mid-ocean arrives when the link does. It
also makes alarm history queryable afterwards — *when did we drag?* The schema:

```
alerts,context=vessels.<urn>,self=true,rule=<id>,kind=<kind>
  raised=1i,transition="raised",state="alarm",message="…",value=111,name="Anchor" <ns>
```

`rule` and `kind` are the only tags — both bounded and stable, so cardinality stays flat.
`transition` and `state` are deliberately **fields**: keeping them out of the series key
means one series per rule, so "is this raised right now" is `last(raised)` on a single
series rather than a merge-and-compare across two — a query that is easy to get wrong, and
wrong in the direction of *no alarm*. Feed conditions ride the same measurement under
`rule=__feed__`. With no cloud account configured, alarms still ring on board and the
status line says `local only (no cloud sync)` rather than letting you assume otherwise.

Our own notifications are **not** also uploaded through the generic delta path — they
would arrive a second time as flattened `notifications.*` rows, describing the same event
in a worse shape in a namespace that means "a device's own condition". Every other
plugin's notifications (the Victron monitors, the server's own) are untouched.

**Drop anchor** — `POST /api/alerts/anchor {ruleId}` — writes the boat's current fix into
the rule and arms the watch in the same step. The datum goes into the *rule* because the
evaluator's in-memory one does not survive a restart or a rule edit, both of which happen
at anchor; and it is taken from the boat's own fix because that is the position the rule
will be evaluated against. A browser would send whatever its last telemetry frame said,
from a socket that may have dropped — which is exactly the moment this matters.

**Rules live on the boat**, in the profile beside routes and polars
(`/api/profile/alerts`), and that copy is deliberately **not** synced with the cloud. For
alarms that is the right way round: a rule edited from ashore must not silently change
what the boat alarms on mid-passage.

Three behaviours worth knowing, because each is a way an alarm system becomes useless:

- **Editing a rule re-arms its alarm.** A rebuilt evaluator has no memory of the raise, so
  anything currently up is taken down explicitly and comes back after its hold time if the
  condition still holds. The alternative is a notification latched at `alarm` that nothing
  can ever clear — which is how an owner learns to mute the path.
- **Stopping the plugin clears what it raised**, loudly, for the same reason: nothing will
  evaluate the rule while it is stopped.
- **A dead feed is not an alarm.** It goes to the status line and the log. It also never
  clears a raised alarm: the input going away is not evidence the danger did.

**Two sources on `navigation.position` disable the anchor alarm — silently.** Not by
false-alarming: the far source reads as *outside* the circle and the good one as *inside*,
and since a raise needs the condition to hold continuously, the alternation resets the
hold time for ever and the alarm never fires at all. This boat had exactly that before its
position source was pinned — a second source a median 2.3 km away, jumping up to 22.7 km
between fixes, while the good receiver at rest scattered a median **1.88 m** from its
centroid (max 2.91 m over 90 minutes). The evaluator now reports it as a feed condition
(three implausible jumps in five minutes), and the plugin says so in the log and on the
status line, naming the fix: set a source priority for `navigation.position`. Metres of
ordinary GPS scatter never trip it.

**A malformed rule is dropped, not stored looking armed.** Rules are validated with the
app's own `validateRule` (vendored with the evaluator), because the evaluator treats an
unknown kind — or a deadband on the wrong side of the threshold, which could never clear —
as *inert*. Such a rule would otherwise sit in the list looking active and never fire. The
status line counts them and the log names each one and why.

**Feed staleness and clocks.** Rules are evaluated on the SignalK timestamp, so the timing
is the data's own, not the machine's — but staleness has to be measured on wall clock (a
dead feed is exactly a timestamp that stops moving). The two are reconciled by bounding
the skew: a SignalK clock more than a minute from system time falls back to system time
with one warning, rather than reporting a permanent phantom "feed stale".

## Two paths, one reading

Source priorities solve *several devices on one path*. There is a second, separate case:
**several paths that mean the same thing**. Signal K publishes active-waypoint course data
under three prefixes — `navigation.courseGreatCircle.nextPoint.*`,
`navigation.courseRhumbline.nextPoint.*` and `navigation.course.calcValues.*` — and the
app maps all three onto the same readouts. A boat publishing more than one gets whichever
delta arrived last, so the waypoint distance alternates: measured on this boat, 2049.48 nm
from great circle against 2050.86 nm from the course provider, several times a second.

`sourcePriorities` cannot fix that — it arbitrates sources on ONE path, and these are
different paths, each legitimately sourced. The plugin therefore applies the precedence
the app already documents on its history side (great circle primary, the other two
`fallback: true`): a lower-priority prefix is ignored while a better one is publishing,
and takes over if that one goes quiet for 10 s.

An audit of the mapper found exactly one other case: **depth**, fed by both
`environment.depth.belowSurface` and `belowTransducer`. On a boat publishing both they
differ by the transducer offset (0.3 m here), so the reading would oscillate in shallow
water where the sounder streams. Same rule, with `belowSurface` preferred — the honest
"how much water is under me" figure, and what the mapper itself calls preferred.

## Heading: the boat's own true heading

Two ways to know true heading — the boat publishes `navigation.headingTrue`, or it is
derived from `headingMagnetic + magneticVariation`. The plugin uses the **published**
value.

Both are TRUE headings and on this boat they agree to 0.12°, so correctness does not
separate them. **Resolution does:**

| | rate | resolution |
|---|---|---|
| `navigation.headingTrue` (AIS transponder) | 1 Hz | whole degrees |
| `navigation.headingMagnetic` (Precision-9) | 20 Hz | 0.006° |

AIS transmits heading as an integer, so the transponder rounds before publishing. The
compass is the same underlying sensor without that rounding, so using it costs nothing in
accuracy and gains 20× the rate — a display that flows instead of stepping once a second.

The published value is still used, as an **independent check**: if the two disagree by
more than 10° something is broken and the log says so, naming both numbers. The displayed
value does not change on the strength of that.

The comparison runs **only when variation is on the bus** — without it the compass yields
raw magnetic, which is wrong by the local declination (16° here), so there is no valid
compass option at all and the boat's own `headingTrue` is used instead.

> This is a deliberate divergence from the app, which makes `headingTrue` authoritative on
> correctness grounds without weighing transmission rounding. Handed back upstream; if it
> ever prefers the higher-resolution source when both are true, this can be dropped.

This also lines the boat up with the cloud's history provider, which takes `headingTrue`
first. (Its fallback converts `headingMagnetic` **without** adding variation, so a boat
publishing only magnetic gets raw magnetic in Trends — an upstream bug, flagged.)

## Several devices publishing the same value

A real N2K network usually has more than one device announcing a given path, and they do
not always agree. On the boat this was developed against: three sources for
`navigation.speedThroughWater`, one of them reporting a constant **0**; and two compasses
on `navigation.headingMagnetic` **7.5° apart**. Whichever delta arrived last won, so speed
dropped to zero intermittently and heading — which the app derives from magnetic heading
plus variation, and which feeds the true-wind calculation — wandered.

**The plugin does not arbitrate this, and deliberately so.** Signal K already resolves it
from `sourcePriorities` in `settings.json`, applied in its delta pipeline *before* any
consumer sees the value, so one setting fixes the app, KIP, the instruments, the local
history ring and the telemetry going to the cloud all at once. Set it under
**Server → Settings → Source Priorities**:

```json
"navigation.speedThroughWater": [{ "sourceRef": "NMEA.27", "timeout": "" }],
"navigation.headingMagnetic":   [{ "sourceRef": "NMEA.23", "timeout": "" }]
```

To find the culprit, compare sources on one path:

```bash
curl -s http://<boat>:3000/signalk/v1/api/vessels/self/navigation/speedThroughWater
```

`values` lists every source and what each is reporting; `$source` is whichever last won.
A path where they disagree is worth pinning. Where a cross-check exists it settles which
is right — magnetic heading plus variation should equal the reported true heading, and on
that boat one compass matched to 0.25° while the other was 7.5° out.

Note that a de-prioritised source still appears **once** when a client subscribes: Signal K
replays current values on subscription. That is a single stale sample, not a live feed.

## Local history (offline Trends + track)
**One source: a live ring**, sampled from the same BoatState that feeds `/ws/telemetry`
— no database, works on a Victron GX with nothing else installed. `historyAvailable` is
forced on so the app shows the Trends panel, and the **nineteen channels match what the
cloud serves** — wind (true/apparent, speed/angle/direction), SOG/STW/COG/heading, depth,
VMG, sea and air temperature, port and starboard revs, and the four active-waypoint
values. So an instrument cell's history flyout shows the same thing whichever provider is
answering. A channel with no data is simply absent: a boat with no paddlewheel has no
`stw`, and the waypoint channels appear only while a destination is active.

There is deliberately **no way to point this at a local InfluxDB**. Until v0.15.0 a read
token did exactly that, and it was a trap: the app only ever asks for a *relative* window
clamped to 24 h, so aiming it at a bucket of older data matched nothing — Trends went
blank **and** the working live ring was switched off. If you still have a token in your
config it is now inert; the plugin logs `history -> live ring` regardless.

A local InfluxDB is not a competitor here anyway. The app never requests finer than
`every=5s` over a 24 h window, and the ring's floor at that window is 2 s — set
`ringSampleSec: 5` and it matches anything the UI can draw, from live state. What an old
database *is* good for is its contents ending up **in the cloud** — see below.

## AIS on the boat's own chart
The app draws other vessels from `GET /api/ais`. The cloud serves that by polling a
SignalK server over the LAN and gates it behind a boat session — neither of which can
work from a boat on a mobile link, and the mirror forwards no cookies, so proxying it
returns 401 whatever you do.

The plugin therefore serves `/api/ais` **from the boat's own SignalK**, in the same
envelope the app already consumes: position, SOG, COG, heading, rate of turn, name,
dimensions and ship type, plus a ~1 h trail per vessel. Anchored ships stay a single dot
— a trail point is added only once a vessel has moved more than 30 m — and a target
unheard for 15 min is dropped. A failed poll keeps the last snapshot rather than blanking
the chart.

This works **with no uplink at all**, which is when other vessels on your chart matter
most. Turn it off by hand-editing `proxy.serveAis: false`.


# 4 · Backfill — an existing archive into the cloud

## Copying older history to the cloud (one-time)
If the boat recorded into its own InfluxDB before it started syncing — a
`signalk-to-influxdb-v2` bucket, or an imported logbook — the **backfill** copies it up
so the cloud holds your full history. Live sync can't do this: it only ever sees deltas
arriving now, and the spool only replays what it captured itself while offline.

Fill the **Copy older history to the cloud** section and save. It walks backwards in
one-hour windows (newest first, so recent history lands first), resumes after a restart
from a manifest, and stands aside whenever live telemetry has a **backlog** — the data-
critical path is never starved by a bulk upload. Progress shows in the status line.

"Backlog" means several files waiting, not merely an upload in flight. Requiring an empty
spool was a race: live sync flushes every second, so once the round trip to the cloud grew
past a second the spool was never empty for an instant and the backfill stood down for
ever — silently, since that path logs nothing. It now yields at a real backlog, which an
outage produces within a minute, and logs both the stand-down and the resume.

**It restarts itself.** A run stops after a streak of failed writes, so a boat that has
gone offline never marks a window falsely done — but it then schedules a fresh walk (1 min,
backing off to 30 min, reset by any successful window) instead of waiting for a human. It
used to end with "resumes on restart", and nothing restarted it: one boat sat idle for 8.6
hours at 96% complete after seven link drops in 13 minutes, while live sync rode out the
same drops with a single retry. A rejected destination (a renamed bucket, a bad token) is
retried the same way, since those are settings and settings get corrected. Genuinely
malformed data still stops for good — retrying cannot fix it.

It needs a **cloud read+write token**, not the write token from signup. Every hour it
uploads is verified by counting the destination, and a write-only token cannot read. A
`204` means InfluxDB accepted the bytes, not that every point landed — without the count
a partial write would be marked done and lost. The token is only needed while the
backfill runs: **revoke it afterwards**, live sync is unaffected.

> The two tokens a boat normally has are **both insufficient**: the scoped read token
> cannot write (`403 insufficient permissions for write`) and the scoped write token
> cannot verify. Mint one carrying *both* permissions on `<slug>_raw`.

### What to expect
This is a background job measured in **days or weeks**, not minutes. Measured on a real
boat — a Raspberry Pi over Starlink, migrating a `signalk-to-influxdb-v2` archive of
~57 GB going back 20 months:

| | |
|---|---|
| sustained throughput | ~10,000 points/s |
| archive consumed | ~24× realtime |
| a dense hour (2.7M points) | subdivides into ~30 chunks |

It gets faster as it goes: the walk is newest-first and older data is usually sparser
(that boat's recent hours held ~2.7M points, its oldest ~0.8M). Leave it running — it
survives restarts, and it yields to live telemetry so it cannot delay your own boat's
data.

**Watching progress.** The status line shows the current window and running total. For
detail, the manifest lists every completed hour:

```bash
cat <dataDir>/backfill.json    # {"done":{...},"points":532062426,"complete":false}
```

From the cloud side, the oldest point in your bucket marches backwards as it works — that
is the single clearest signal that it is delivering:

```flux
from(bucket:"<slug>_raw")|>range(start:0)|>keep(columns:["_time"])|>group()|>min(column:"_time")
```

Once the bucket is large that query gets expensive; counting a single one-hour window
near the frontier is cheaper and tells you the same thing.

Safe to re-run. Points are keyed by (measurement, tagset, nanosecond timestamp), so an
identical point overwrites rather than duplicating — an interrupted migration is simply
run again.

**Only this boat's data is copied**, and that is not configurable. The cloud's history
queries assume your bucket holds one vessel, so uploading an archive's AIS would put
other ships into your own SOG and heading charts. If the source holds several contexts
the plugin copies yours and logs which it skipped. If it holds exactly **one** context it
is copied whatever identity string it uses — a bucket with one vessel cannot be an AIS
collection, and this is what lets an archive recorded under an older Signal K UUID (or an
MMSI URN) still migrate. Hand-edit `backfill.context` to force a specific one.

A run that copies **zero** points is reported as a problem, not as success: that almost
always means the org or bucket is wrong rather than that the archive is empty.

**It starts below what live sync already covers.** The destination's own oldest point is
the moment cloud sync began, so the walk begins there rather than at *now*. Without that,
a source archive that is still being written — a `signalk-to-influxdb-v2` bucket still
recording — makes the first windows re-upload today's data. The timestamps are correct,
but it is data the cloud already has, and a lot of wasted uplink.

**Latency is the cost, not bandwidth.** Measured on a real archive, about 3 s of every
4.2 s chunk was cloud round trips while all the boat-side work (query, parse, convert)
took ~1.2 s. So batches carry up to 50k lines rather than 10k — one or two round trips
per chunk instead of ten — and each **hour** is verified once rather than each of its
~32 chunks. The verification itself is unchanged in kind: a `204` means the bytes were
accepted, not that every point landed, so the destination is still counted before an
hour is marked done. On a mismatch the hour is left unmarked and simply redone, which is
safe because writes are idempotent.

**Field types come from the source, not from guessing.** Queries ask InfluxDB for the
`#datatype` annotation explicitly. Without it the response is unannotated and types have
to be inferred from the text — which fails hard on a string field whose values sometimes
look numeric (`"8"` emitted bare as a float, `"1.2.3.4"` quoted as a string), producing
`422 field type conflict` and aborting the run. Integers also keep their type instead of
silently becoming floats.

**Dense archives are subdivided.** A window is read whole and converted in memory, and a
busy boat can produce millions of points an hour (54M/day was measured on a real boat —
about 400 MB of CSV per hour). When a window holds more than `maxRowsPerChunk` points it
is halved until it fits, down to a one-minute floor. The count is already known before
the read, so this costs nothing extra.

**True wind comes from your instruments.** If the boat publishes
`environment.wind.speedTrue` / `directionTrue`, those are stored verbatim — a wind
system corrects for heel and leeway against water-referenced boat speed, and every other
display aboard shows its numbers. Only when the boat publishes none is true wind
derived, and then from **STW**, not SOG: true wind is relative to motion through the
water. (Before v0.14.6 the derivation used SOG, which in 3 kt of foul tide skewed TWD by
~12° and TWS by ~1.8 kt.) SOG is the last resort for boats with no paddlewheel.
  - **Persistent (append-log):** the ring is saved as a JSONL append-log at
    `<dataDir>/history/history-ring.jsonl` (on the SSD/USB with the tiles; override with
    `proxy.history.ringDir`), so it **survives restarts**. Each sample appends one line; the file is
    compacted (atomic rewrite to the current window) only rarely, so a long passage
    writes < ~1 GB (vs the ~600 GB a full-rewrite snapshot would). Config
    `proxy.history.ringWindowSec` (default 24 h, up to 2 592 000 = 30 d),
    `ringSampleSec` (auto-coarsened so the ring stays ≤ ~50 k samples at any window),
    `ringPersist` (default on; off = in-memory only). NB: the app currently caps
    history requests at 24 h — a >24 h window needs the app-side clamp raised too.

The sailkick app is deployment-agnostic about history: *central Influx in the
cloud, in-memory ring on a DB-less edge*. The boat is a third case — an edge that
serves the app's history endpoints from its **own** live data:
```
GET /api/history/series?window=3600s&every=30s -> { series: { sog|heading|tws|… : [[tMs,val],…] } }
GET /api/history/series?…&stats=1&chans=sog,aws -> { series: {…}, bands: { sog: [[t,min,max],…] } }
GET /api/history/track?window=3600s&every=10s  -> { track: [{ t, lat, lon }, …] }
GET /api/history/track?from=<epochMs>&to=<epochMs>   (absolute range; ISO also accepted)
```
**Gusts: `stats=1` adds true min/max bands under the mean.** A mean line hides the thing
you actually want to see — the app measured an hour of real sailing at 20 s buckets where
the mean spanned 4.8 kt and the true envelope spanned 8.3 kt, with 1.87 kt of spread
hidden inside an average bucket. That spread only exists if it is *recorded*: the ring
polls BoatState every second into a per-channel `{sum, cnt, lo, hi}` accumulator and emits
one row per sample interval carrying the mean plus the true extremes seen inside it. It
used to snapshot instead, throwing away 14 of every 15 readings before anything could ask
a question about them — no later bucketing, on the boat or in the browser, can bring those
back.

A useful side-effect: the auto-coarsening that keeps the ring under `MAX_SAMPLES` is no
longer lossy. Only the *emit* rate coarsens, never the poll, so a 30-day passage emitting
every ~52 s still carries the true min/max within each 52 s.

**Compass channels never get a band** — `twd`, `twa`, `awa`, `cog`, `heading`, `wptBrg`.
The mean of 359° and 1° is 180°, the exact opposite of the truth, so those carry a
last-reading snapshot and no band, ever. It is the one error here that would look entirely
plausible on screen, so the tests pin it.

`chans=sog,aws` narrows the answer to the channels actually plotted; `bands` appears only
when `stats=1` was asked *and* the provider produced them, so every client degrades to the
plain line. `series` is unchanged with or without either param.

Both endpoints take **either** a trailing `window`, **or** an absolute `from`/`to` —
which is what the app sends whenever the view is scrolled back in time (the historic
trail, and a Trends flyout on a past period). The response echoes the `from`/`to` it
actually served. Before 0.24.0 the boat parsed only `window`, so a request for a past
hour came back `200` with the **most recent** hour: the historic trail silently showed
live data. `every` thins a long track and always keeps the first and newest fix; on
`series` it re-buckets (means weighted by the sample count behind each row, extremes as
min-of-mins), labelling each bucket at its **end** to match the cloud's
`aggregateWindow(timeSrc: "_stop")` — label them at the start and the two providers plot
half a bucket apart on the same screen. It is floored so one answer stays under ~3k
points, as the cloud route does.

Same JSON the cloud returns, so the browser can't tell the difference — but it
works **offline** with the boat's own data. Only when no telemetry source is
available at all do these paths **fall through to the cloud mirror**, so an
online boat is never worse off than before.


# Running it

## Setup: register on the web, then paste the token
1. Register your boat at **[www.sailkick.io](https://www.sailkick.io)** (an invite code
   is needed — see above). The signup screen shows your boat's ingest credentials.
2. **Copy the "Write token"** — it is shown **once** and cannot be recovered. If you
   lose it you need a new one minted.
3. In Plugin Config, fill the **Sailkick account** section — **write token**, plus
   either the **boat name** or the **data bucket** — and save.

That is the whole handshake. The plugin resolves everything else locally (`org` =
`sailkick`) and never calls the app for configuration, so setup works with no internet
and there is nothing to re-fetch after a restart.

**Data bucket.** Leave it blank and the bucket is derived as `<boat name>_raw`, which is
what older accounts use. Newer accounts are identified by a UUID instead — their bucket
looks like `1fcad258-c422-4e93-a6f9-6811938499f6_raw` — so paste that into **Data
bucket** and the boat name becomes optional. If your bucket is ever renamed, this is the
one field to change: the write token survives a rename, because InfluxDB scopes tokens by
bucket *id* rather than by name.

A bucket that does not exist is treated as a **configuration error, not bad data**:
telemetry is held on disk, nothing is quarantined, the status line reads
`sync: HELD — bucket "…" not found`, and it sends itself as soon as the name is
corrected — no restart needed. The same applies to a rejected token.

> **Upgrading from before 0.14?** Old versions had visible `influxUrl` / `sailkickUrl`
> fields. Whatever was typed into them is still in your saved config, and since 0.14.4
> those leftovers are **ignored** — the plugin says so in the log and the status line
> rather than silently obeying a dev address. To keep your own endpoints deliberately,
> set `sync.selfHosted: true` / `proxy.selfHosted: true` in the config JSON.
>
> **Ignore the "Influx URL", "Organization" and "Bucket" on that screen** — they are for
> the community `signalk-to-influxdb-v2` plugin. This plugin always writes to
> `https://sync.sailkick.io`; the endpoint is fleet-wide and cannot be set from the UI,
> so a wrong value can never redirect your telemetry. (Self-hosters: hand-edit
> `sync.influxUrl` in the plugin config JSON.) If the status line ever warns that sync is
> writing to a local address, telemetry is not leaving the boat.

Registration deliberately happens **only** in the web app. The plugin cannot sign up,
so there is no way to half-create an account or burn an invite from the boat.

> Changing the token later — after a rotation, say — is just editing the field and
> saving. Pasted values are trimmed, and the boat name is lower-cased for you.

## Config
The page is deliberately small — everything else has a right answer and is a constant
in `index.js`.

- **Sailkick account**: `slug` (boat name), `writeToken`
- **Telemetry sync → cloud**: `enabled`
- **Upload AIS targets**: `enabled` (default off), `source`
- **Alerts & alarms**: `enabled` (default on — inert until you add a rule),
  `notifications` (whether to put alarms on the SignalK bus)
- **Offline app & maps**: `enabled`, `proxyPort` (default 8080), `localSignalkUrl`
  (default `http://127.0.0.1:3000`), `dataDir`, `seedEnabled`, `prefetchRadiusNm`,
  `prefetchDetailZoom`

`dataDir` is the one storage location — cached maps, the telemetry spool and the
history ring log all live under it. **Put it on the SSD/USB disk, not the SD card.**
Leave it blank and each part falls back to its historical spot under the plugin data
dir.

Cache-manifest polling is always on (no toggle): tile freshness comes from the cloud
announcing bakes, and without it a re-baked dataset would never refresh.

**Self-hosting / advanced.** Every module still reads its option before falling back to
the constant, so anything removed from the page can be set by hand in
`~/.signalk/plugin-config-data/sailkick-boat.json` — `sync.influxUrl`, `sync.token`,
`proxy.sailkickUrl`, `proxy.seed.coastlineMaxZoom`, the ring window, the retry backoff,
and so on. Values saved by earlier versions keep working after an upgrade.

Point your chart app / browser at:
`http://<boat>:3000/plugins/sailkick-boat/p/`

## Install (like any Signal K plugin)
```bash
cd ~/.signalk && npm install sailkick-boat   # or a packed tarball
```
The plugin **enables itself on install** and appears in Signal K's **Webapps** menu as
**Sailkick** — a launcher with two entries, "Open Sailkick" (full app) and "Open on
phone" (mobile view). Both point at the mirror on this boat, so nothing has to be typed
by hand. One npm package can only produce one menu item — Signal K dedupes webapps by
package name — hence one launcher rather than two entries.

Nothing is uploaded by enabling it. Telemetry sync needs an account write token and
refuses to start without one; AIS upload and the backfill are off by default; and the
worldwide base-map seed is skipped entirely on an unpaired boat, so a fresh install
downloads only what you actually look at. **The whole app works with no account** —
charts, instruments, trends, AIS, routes and polars are all served from the boat. An
account adds cloud sync, off-boat access and long-term history.

Set **Data directory** to a path on the SSD (or leave blank for the plugin data dir) —
that is the one setting worth changing straight away.

### Victron GX / Venus OS (Cerbo, Ekrano)
Works on Venus OS Large (Signal K enabled). Point **Data directory** at USB/SD storage
(internal flash is small). Leave the history token
blank — the DB-less telemetry ring is used automatically. **Note:** a GX only sees
Victron data (batteries, solar, tanks) by default; **position/wind/speed/depth
require the boat's NMEA2000 backbone on the VE.Can port** (250 kbit/s N2K profile +
a VE.Can↔Micro-C drop cable; leave the spare RJ45 unterminated) or a USB GPS/N2K
gateway. Without a position source, the live boat / trends / area-download stay
idle — energy telemetry still syncs to the cloud.

## Troubleshooting: is telemetry actually leaving the boat?
The plugin logs one unconditional line at startup naming its real target:
```
[sailkick-boat] sync -> https://sync.sailkick.io org=sailkick bucket=<slug>_raw
```
If that shows anything other than the endpoint you expect, a stale config field is the
usual cause — see the upgrade note above.

Failures reach the **normal server log**, not just the debug channel:
- `cannot write to <url> — unreachable …; N failed attempt(s), telemetry is buffering
  on disk` — once per outage, then every 5 min while it lasts, then a `recovered` line.
- `batch REJECTED (HTTP 401) and quarantined …` — the write token is not valid for that
  bucket. These are never retried, so they are always logged.
- `sync: ⚠ writing to <url> — a private address` — a loopback/RFC1918 target, i.e.
  nothing is reaching the cloud.

Nothing at all in the log means the plugin never started; check it is enabled. The
status line in Plugin Config carries the same information continuously.

To prove credentials independently of the plugin:
```bash
curl -i -XPOST "https://sync.sailkick.io/api/v2/write?org=sailkick&bucket=<slug>_raw&precision=ns" \
  -H "Authorization: Token $TOKEN" --data-binary "probe,context=vessels.self,self=true,source=manual value=1"
```
`204` = good, `401` = token not valid for that bucket.

## Known gaps
Things this deliberately does not do yet, so they don't come as a surprise:

- **Wind and current fields are not prefetched.** Velocity tiles are pinned once fetched
  (they are keyed by forecast run, so they never go stale), but nothing warms them ahead
  of time — offline, the wind field covers only where you have already panned. Old
  forecast runs are also never pruned, so their tiles accumulate.
- **The backfill cannot fill gaps in live coverage.** It only copies data *older* than
  the point where cloud sync began, so if live sync ever dropped data — an outage longer
  than the spool's capacity — that hole stays, even when the local archive still has it.
- **Backfilled history is not browsable in the app.** `/api/history/*` accepts only a
  relative window clamped to 24 h, so once 2024 is in the cloud there is still no way to
  display it. That needs `from`/`to` support server-side.
- **Routes saved on the boat don't reach the cloud, and vice versa.** `/api/profile/*` is
  served from a file on board because the cloud's copy is session-gated and unreachable
  from the mirror. The two copies never merge, so a route drawn at anchor won't show up
  in the web app on shore.
- **Per-path sync rate is approximate.** The subscription sets `period` without a
  `policy`, so Signal K's default governs and a few chatty paths exceed the configured
  interval.

## Dev / tests
```bash
npm install && npm test   # proxy: mirror/cache/offline + Express route; sync: subscribe+buffer
```
Supersedes the separate `signalk-to-influxdb-gapless` + `signalk-tile-cache` plugins.

## Contact
Questions, feedback, or want to test the app on your own boat?
Email **[info@sailkick.io](mailto:info@sailkick.io)** — happy to help with setup, and
early testers are very welcome. Bug reports and feature requests are also fine as
[GitHub issues](https://github.com/lauchat/sailkick-boat/issues).

## License
MIT
