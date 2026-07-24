# sailkick-boat

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
    from the boat's local InfluxDB (or a DB-less telemetry ring) — full local history.

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
(pinned, offline forever). Dynamic `/api/*` data (AIS, weather) is **network-first**:
fetched live every time online (so AIS/weather never go stale), with the last
response kept only as an **offline fallback** (`STALE`). Local `/api/history` and the
patched `/api/config` are served specially (above).

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
(The persistent history ring log lives under `<storeDir>/history`, so keep `history`
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
  Config: `proxy.seed.{enabled,coastlineMaxZoom,seabedMaxZoom,concurrency}`.
- **Download around the boat** (settings dropdowns, no token) — the easiest way to
  cache a passage area: in Plugin Config pick a **Radius around boat** (25/50/100/200 nm)
  and a **Detail level** (Overview z12 … Harbor z15), then save. The plugin reads the
  boat's current position from local SignalK, builds a box, and warms the chart layers
  in the background (progress in the status line). Idempotent; re-saving tops up. An
  oversized radius+detail is refused (reduce one). Config `proxy.prefetch.{radiusNm,detailZoom,concurrency}`.
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
config passes through untouched. Toggle off with `proxy.openAccess: false` to keep
the cloud login gate.

## Local history (offline Trends + track)
Two ways, chosen automatically:
- **Read token set** → full history queried from a **local InfluxDB** (e.g. a bucket
  written by `signalk-to-influxdb-v2`).
- **No token, telemetry on** → a **DB-less ring** sampled from live telemetry (the
  same BoatState feeding `/ws/telemetry`) — for boats with no local InfluxDB, e.g.
  **SignalK on a Victron GX / Venus OS**. Same JSON contract, fully offline, no database.
  (`historyAvailable` reports true either way, so the app shows the Trends panel.)
  - **Persistent (append-log):** the ring is saved as a JSONL append-log at
    `<storeDir>/history/history-ring.jsonl` (on the SSD/USB with the tiles; override with
    `proxy.history.ringDir`), so it **survives restarts**. Each sample appends one line; the file is
    compacted (atomic rewrite to the current window) only rarely, so a long passage
    writes < ~1 GB (vs the ~600 GB a full-rewrite snapshot would). Config
    `proxy.history.ringWindowSec` (default 24 h, up to 2 592 000 = 30 d),
    `ringSampleSec` (auto-coarsened so the ring stays ≤ ~50 k samples at any window),
    `ringPersist` (default on; off = in-memory only). NB: the app currently caps
    history requests at 24 h — a >24 h window needs the app-side clamp raised too.

The sailkick app is deployment-agnostic about history: *central Influx in the
cloud, in-memory ring on a DB-less edge*. The boat is a third case — an edge that
serves the app's history endpoints from its **own** data (local InfluxDB or the ring):
```
GET /api/history/series?window=3600s&every=30s -> { series: { sog|heading|tws|… : [[tMs,val],…] } }
GET /api/history/track?window=3600s            -> { track: [{ t, lat, lon }, …] }
```
Same JSON the cloud returns, so the browser can't tell the difference — but it
works **offline** with the boat's own data. Only when neither a local InfluxDB nor
telemetry is available do these paths **fall through to the cloud mirror**, so an
online boat is never worse off than before.

## Easiest setup: log in with your sailkick account
Instead of pasting InfluxDB URL / org / bucket / write-token, fill the **Sailkick
account** section — **host URL + slug + password** — and the plugin fetches the rest of
its cloud config on start (`POST <host>/api/boat/config`): the scoped write token,
bucket, org, and InfluxDB URL for your boat. The bundle is cached (0600) in the plugin
data dir, so sync keeps working **offline** after the first connect. Leave the account
section blank to configure `sync`/`proxy` manually (advanced / self-hosted). Account
values take precedence over the manual sync fields; the mirror upstream (`sailkickUrl`)
is set from the account host.

## Config (each section toggleable)
- **Telemetry sync → InfluxDB**: `enabled`, `influxUrl`, `org`, `bucket`, `token`, `spoolDir`, …
- **Sailkick caching proxy**: `enabled`, `sailkickUrl` (the one upstream), `storeDir`, …
  - `serveTelemetry` (default on) — provide `/ws/telemetry` from local SignalK.
  - **Cache manifest** (default on): `path` (default `/api/cache-manifest`),
    `pollIntervalSec` (default 300) — auto-refresh datasets when the cloud
    announces a new bake.
  - **Local history** (default on): `influxUrl` (default `http://127.0.0.1:8086`),
    `org`, `bucket`, `token` (a read token — set to serve full history from a local
    InfluxDB; blank = the DB-less telemetry ring), plus the ring settings above.

Point your chart app / browser at:
`http://<boat>:3000/plugins/sailkick-boat/p/`

## Install (like any Signal K plugin)
```bash
cd ~/.signalk && npm install sailkick-boat   # or a packed tarball
```
Enable + configure under **Server → Plugin Config → "Sailkick boat companion"**.
Put `spoolDir`/`storeDir` on the SSD (or leave blank for the plugin data dir).

## Dev / tests
```bash
npm install && npm test   # proxy: mirror/cache/offline + Express route; sync: subscribe+buffer
```
Supersedes the separate `signalk-to-influxdb-gapless` + `signalk-tile-cache` plugins.

## License
MIT
