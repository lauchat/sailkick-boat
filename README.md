# sailkick-boat

One Signal K plugin, two independently-toggleable modules — so the boat stays
"just SignalK + plugins":

- **`sync`** — gapless store-and-forward of self-vessel telemetry to InfluxDB v2
  (durable spool; survives offline + restarts). Data **out**.
- **`proxy`** — offline-first caching **mirror of the sailkick host**: fetch once
  online, serve from disk forever (incl. offline). Data **in**.

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

## Config (two sections, each toggleable)
- **Telemetry sync → InfluxDB**: `enabled`, `influxUrl`, `org`, `bucket`, `token`, `spoolDir`, …
- **Sailkick caching proxy**: `enabled`, `sailkickUrl` (the one upstream), `storeDir`, …

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
