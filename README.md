# sailkick-boat

> ## ⚠️ Project status: early alpha — invite only
>
> This plugin is the **boat-side companion of the sailkick platform**: **cloud
> telemetry** (gapless boat→shore sync of your vessel's data into a central InfluxDB)
> and a **local proxy that keeps the sailkick app and its charts/maps fully usable
> offline** on board. The service runs at **[www.sailkick.io](https://www.sailkick.io)**.
>
> **Registration is invite-only** and happens on the website, not in the plugin — so
> installing this from the Signal K Appstore is not enough on its own. Expect breaking
> changes while the version is 0.x.
>
> **Want an invite, or more information?** Get in touch:
> **[info@sailkick.io](mailto:info@sailkick.io)**. Early testers are welcome.
> Self-hosters can point the plugin at their own sailkick server and InfluxDB v2
> instead — see [Config](#config).

One Signal K plugin, independently-toggleable modules — so the boat stays
"just SignalK + plugins":

- **`sync`** — gapless store-and-forward of self-vessel telemetry to InfluxDB v2
  (durable spool; survives offline + restarts). Data **out**.
- **`proxy`** — offline-first caching **mirror of the sailkick host**: fetch once
  online, serve from disk forever (incl. offline). Data **in**.
- served alongside the mirror, from the boat's **own** data (so the app uses the
  same contracts as the cloud, offline-first):
  - **`/ws/telemetry`** — the app's live telemetry bus, fed from local SignalK.
  - **`/api/history/{series,track}`** — the app's Trends panel + track, served
    from a live ring sampled on the boat — full local history, no database.

Kept as separate modules so a proxy fault can't wedge the data-critical sync path.

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

## No login on the boat (single-tenant)
The cloud app gates behind a boat-account login (a `Secure` session cookie), which
can't work over the boat's plain-HTTP offline mirror — the browser drops a `Secure`
cookie on HTTP, so login just loops. Since the boat is single-tenant and its data
endpoints aren't server-gated, the proxy serves `/api/config` with `auth.required`
forced to `false` (and `historyAvailable` forced on when history is served locally),
so the boat's own app opens with no password, fully offline. Everything else in the
config passes through untouched. (Hand-edit `proxy.openAccess: false` to keep the cloud
login gate — there is no toggle, since the gate cannot complete over the mirror anyway.)

## Local history (offline Trends + track)
**One source: a live ring**, sampled from the same BoatState that feeds `/ws/telemetry`
— no database, works on a Victron GX with nothing else installed. `historyAvailable` is
forced on so the app shows the Trends panel, and the eight channels match what the cloud
serves, `stw` included.

There is deliberately **no way to point this at a local InfluxDB**. Until v0.15.0 a read
token did exactly that, and it was a trap: the app only ever asks for a *relative* window
clamped to 24 h, so aiming it at a bucket of older data matched nothing — Trends went
blank **and** the working live ring was switched off. If you still have a token in your
config it is now inert; the plugin logs `history -> live ring` regardless.

A local InfluxDB is not a competitor here anyway. The app never requests finer than
`every=5s` over a 24 h window, and the ring's floor at that window is 2 s — set
`ringSampleSec: 5` and it matches anything the UI can draw, from live state. What an old
database *is* good for is its contents ending up **in the cloud**, where the app can
query them properly. See the roadmap note below.

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
GET /api/history/track?window=3600s            -> { track: [{ t, lat, lon }, …] }
```
Same JSON the cloud returns, so the browser can't tell the difference — but it
works **offline** with the boat's own data. Only when no telemetry source is
available at all do these paths **fall through to the cloud mirror**, so an
online boat is never worse off than before.

## Setup: register on the web, then paste the token
1. Register your boat at **[www.sailkick.io](https://www.sailkick.io)** (an invite code
   is needed — see above). The signup screen shows your boat's ingest credentials.
2. **Copy the "Write token"** — it is shown **once** and cannot be recovered. If you
   lose it you need a new one minted.
3. In Plugin Config, fill the **Sailkick account** section — **boat name + write
   token** — and save.

That is the whole handshake. The plugin resolves everything else locally (`bucket` =
`<slug>_raw`, `org` = `sailkick`) and never calls the app for configuration, so setup
works with no internet and there is nothing to re-fetch after a restart.

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
Enable + configure under **Server → Plugin Config → "Sailkick boat companion"**.
Set **Data directory** to a path on the SSD (or leave blank for the plugin data dir).

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
