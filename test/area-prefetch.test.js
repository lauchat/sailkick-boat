'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { boxAround } = require('../lib/proxy/tiles')
const { createProxy } = require('../lib/proxy')

let seq = 0
const tmpStore = () => path.join(os.tmpdir(), `sk-area-${process.pid}-${seq++}`)
const listen = (srv) => new Promise((r) => srv.listen(0, r))

const appAt = (pos) => ({
  debug () {},
  getSelfPath (p) { return p === 'navigation.position' ? { value: pos } : undefined }
})

test('boxAround: 60 nm ≈ 1° of latitude, longitude widened by 1/cos(lat)', () => {
  const [w, s, e, n] = boxAround(0, 0, 60)
  assert.ok(Math.abs((n - s) - 2) < 1e-9, '±1° latitude span at 60 nm')
  assert.ok(Math.abs((e - w) - 2) < 1e-9, 'at the equator lon span == lat span')
  const box = boxAround(60, 0, 60) // cos(60°)=0.5 → lon span doubles
  assert.ok(Math.abs((box[2] - box[0]) - 4) < 1e-6, 'lon span widens with latitude')
})

test('area prefetch: warms a radius around the boat position and reports progress', async () => {
  let hits = 0
  const srv = http.createServer((req, res) => { if (req.url.startsWith('/tiles/')) hits++; res.setHeader('content-type', req.url.endsWith('.pbf') ? 'application/x-protobuf' : 'image/png'); res.end('T') })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const proxy = createProxy(appAt({ latitude: 40.7, longitude: -74.0 }), {
    sailkickUrl: up, proxyPort: 0, storeDir: tmpStore(),
    manifest: { enabled: false }, seed: { enabled: false },
    prefetch: { radiusNm: 25, detailZoom: 10, concurrency: 3 }
  })
  proxy.start()
  const a = proxy._area()
  assert.ok(a && a.total > 0, 'area prefetch planned')
  await a.promise
  const done = proxy._area()
  assert.strictEqual(done.running, false, 'finished')
  assert.strictEqual(done.done, done.total, 'progress reached total')
  assert.ok(hits >= done.total / 2, 'tiles were fetched')

  proxy.stop()
  await new Promise((r) => srv.close(r))
})

test('area prefetch: off (radius 0) plans nothing; no position schedules a retry (area stays null)', async () => {
  const srv = http.createServer((req, res) => res.end('T'))
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`

  const off = createProxy(appAt({ latitude: 40.7, longitude: -74.0 }), { sailkickUrl: up, proxyPort: 0, storeDir: tmpStore(), manifest: { enabled: false }, seed: { enabled: false }, prefetch: { radiusNm: 0 } })
  off.start()
  assert.strictEqual(off._area(), null, 'radius 0 → nothing')
  off.stop()

  // no position fix yet → retry scheduled, area still null (we don't wait 10s)
  const noPos = createProxy({ debug () {}, getSelfPath () { return undefined } }, { sailkickUrl: up, proxyPort: 0, storeDir: tmpStore(), manifest: { enabled: false }, seed: { enabled: false }, prefetch: { radiusNm: 50 } })
  noPos.start()
  assert.strictEqual(noPos._area(), null, 'no position → not planned yet')
  noPos.stop()

  await new Promise((r) => srv.close(r))
})

test('area prefetch: oversized radius+detail is capped without fetching', async () => {
  let hits = 0
  // count TILE fetches only — the proxy also probes /api/assets for layer zoom limits
  const srv = http.createServer((req, res) => { if (req.url.startsWith('/tiles/')) hits++; res.end('T') })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const proxy = createProxy(appAt({ latitude: 40.7, longitude: -74.0 }), {
    sailkickUrl: up, proxyPort: 0, storeDir: tmpStore(),
    manifest: { enabled: false }, seed: { enabled: false },
    prefetch: { radiusNm: 200, detailZoom: 15 } // ~hundreds of thousands of tiles
  })
  proxy.start()
  const a = proxy._area()
  assert.ok(a && a.capped === true, 'capped')
  await new Promise((r) => setTimeout(r, 50))
  assert.strictEqual(hits, 0, 'capped request fetched nothing')
  proxy.stop()
  await new Promise((r) => srv.close(r))
})

// --- per-layer zoom clamp (v0.18.3) -------------------------------------------------
// Layers top out at very different zooms upstream — coastline at 13 where osm-standard
// reaches 19 — so one "detail level" applied to all of them spent a quarter of a real
// 50nm/z15 budget on ~55k coastline requests that could only 404, and those counted
// toward the cap.
test('prefetch clamps each layer to the zoom it actually publishes', async () => {
  const asked = new Set()
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/tiles/')) asked.add(req.url)
    if (req.url === '/api/assets') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({
        tiles: { manifest: { maxZoom: { 'osm-standard': 19, seamap: 18, bathy: 16 } } },
        coastline: { maxZoom: 13 }
      }))
    }
    res.setHeader('content-type', req.url.endsWith('.pbf') ? 'application/x-protobuf' : 'image/png')
    res.end('T')
  })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const proxy = createProxy(appAt({ latitude: 43.3, longitude: 5.4 }), {
    sailkickUrl: up, proxyPort: 0, storeDir: tmpStore(),
    manifest: { enabled: false }, seed: { enabled: false },
    prefetch: { radiusNm: 2, detailZoom: 15, concurrency: 4 }
  })
  proxy.start()
  await proxy._area().promise

  const zoomOf = (u) => Number(u.split('/')[3])
  const top = (layer) => Math.max(...[...asked].filter((u) => u.startsWith(`/tiles/${layer}/`)).map(zoomOf))
  assert.strictEqual(top('coastline'), 13, 'coastline stops at its published max, not the requested z15')
  assert.strictEqual(top('osm-standard'), 15, 'layers that go deeper still get the full requested zoom')
  assert.strictEqual(top('seamap'), 15)
  assert.strictEqual(top('bathy'), 15)
  assert.ok(![...asked].some((u) => u.startsWith('/tiles/coastline/14/') || u.startsWith('/tiles/coastline/15/')),
    'no request is made for a coastline tile that cannot exist')

  proxy.stop()
  try { srv.closeAllConnections() } catch {}
  await new Promise((r) => srv.close(r))
})

test('the cap is evaluated by arithmetic, never by enumerating', async () => {
  // A global z0-15 request is ~1.4 billion tiles per layer. Counting first is what keeps
  // that out of an array; enumerating first would exhaust memory before the cap is seen.
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'image/png'); res.end('T') })
  await listen(srv)
  const proxy = createProxy(appAt({ latitude: 0, longitude: 0 }), {
    sailkickUrl: `http://127.0.0.1:${srv.address().port}`, proxyPort: 0, storeDir: tmpStore(),
    manifest: { enabled: false }, seed: { enabled: false }, prefetch: { radiusNm: 0 }
  })
  proxy.start()
  const started = Date.now()
  const r = await new Promise((resolve) => {
    const req = { on (e, cb) { if (e === 'data') cb(JSON.stringify({ bbox: [-180, -85, 180, 85], minZoom: 0, maxZoom: 15 })); if (e === 'end') cb() }, setEncoding () {} }
    proxy.handlePrefetchRegion(req, { status () { return this }, json (b) { resolve(b) } })
  })
  assert.strictEqual(r.capped, true)
  assert.ok(r.estimate > 50000)
  assert.ok(Date.now() - started < 5000, 'answered by counting, not by building a billion paths')
  proxy.stop()
  try { srv.closeAllConnections() } catch {}
  await new Promise((res) => srv.close(res))
})

// Regression, seen on a real boat (v0.19.0): disabling the plugin while a 46k-tile
// prefetch was in flight logged
//   TypeError: Cannot set properties of null (setting 'running')  at lib/proxy/index.js:505
// stop() nulls the `area` slot, but warmMany keeps going for minutes and its settling
// handlers wrote straight into that slot. The handlers now hold their own reference.
test('area prefetch: stopping mid-flight does not throw, and a stale run cannot report into a newer one', async () => {
  let hits = 0
  // slow upstream, so the prefetch is guaranteed to still be running when we stop
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/tiles/')) hits++
    setTimeout(() => { res.setHeader('content-type', 'image/png'); res.end('T') }, 15)
  })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`

  const rejections = []
  const onRej = (e) => rejections.push(e)
  process.on('unhandledRejection', onRej)

  const proxy = createProxy(appAt({ latitude: 40.7, longitude: -74.0 }), {
    sailkickUrl: up, proxyPort: 0, storeDir: tmpStore(),
    manifest: { enabled: false }, seed: { enabled: false },
    prefetch: { radiusNm: 25, detailZoom: 11, concurrency: 2 }
  })
  proxy.start()
  const run = proxy._area()
  assert.ok(run && run.running, 'prefetch is in flight')

  proxy.stop() // nulls the area slot while warmMany is still going
  assert.strictEqual(proxy._area(), null, 'slot cleared by stop')

  // the in-flight run must settle cleanly against its own reference
  await run.promise
  assert.strictEqual(run.running, false, 'the stale run finished without throwing')
  assert.strictEqual(proxy._area(), null, 'and did not resurrect the cleared slot')

  await new Promise((r) => setTimeout(r, 50)) // let any rejection surface
  process.removeListener('unhandledRejection', onRej)
  assert.deepStrictEqual(rejections, [], 'no unhandled rejection from the settling handlers')

  try { srv.closeAllConnections() } catch {}
  await new Promise((r) => srv.close(r))
})
