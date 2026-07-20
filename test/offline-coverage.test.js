'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { getResource } = require('../lib/proxy/cache')
const { deg2tile, bboxTileRange, countBboxTiles } = require('../lib/proxy/tiles')
const { createSeeder } = require('../lib/proxy/seed')
const { createProxy } = require('../lib/proxy')

const app = { debug () {} }
let seq = 0
const tmpStore = () => path.join(os.tmpdir(), `sk-off-${process.pid}-${seq++}`)
const listen = (srv) => new Promise((r) => srv.listen(0, r))

// ---------- tiles.js ----------
test('tiles: deg2tile matches known slippy coords; bbox range + count', () => {
  assert.deepStrictEqual(deg2tile(40.758, -73.985, 12), [1206, 1539], 'Manhattan z12')
  assert.deepStrictEqual(deg2tile(0, 0, 1), [1, 1])
  const bbox = [-74.05, 40.70, -73.95, 40.80] // small box around Manhattan
  const r = bboxTileRange(bbox, 12)
  assert.ok(r.x0 <= r.x1 && r.y0 <= r.y1)
  // north (40.80) is the smaller y (top); count is inclusive
  const n = countBboxTiles(bbox, 12, 12)
  assert.strictEqual(n, (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1))
})

// ---------- negative caching ----------
test('negative cache: 404 writes a sentinel; re-request returns 404 with no 2nd fetch', async () => {
  let hits = 0
  const srv = http.createServer((req, res) => { hits++; res.statusCode = 404; res.end('nope') })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()

  await assert.rejects(() => getResource({ storeDir, upstream: up, reqPath: '/tiles/coastline/3/1/2.pbf' }), (e) => e.status === 404)
  assert.strictEqual(hits, 1, 'fetched once')
  // second request: sentinel serves the 404 with no upstream hit
  await assert.rejects(() => getResource({ storeDir, upstream: up, reqPath: '/tiles/coastline/3/1/2.pbf' }), (e) => e.status === 404)
  assert.strictEqual(hits, 1, 'no second fetch — negative-cached')

  // a newer bake (invalidatedAt in the future) makes the sentinel stale → re-fetch
  await assert.rejects(() => getResource({ storeDir, upstream: up, reqPath: '/tiles/coastline/3/1/2.pbf', invalidatedAt: Date.now() + 60000 }), (e) => e.status === 404)
  assert.strictEqual(hits, 2, 'sentinel invalidated → refetched')

  await new Promise((r) => srv.close(r))
})

// ---------- seeder: parent-guided descent ----------
// Fake sparse coastline: a scripted set of non-empty tiles; everything else 404.
// seabed: a single z0 tile (seabedMaxZoom 0).
function sparseUpstream (existing) {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    const m = req.url.match(/\/tiles\/(coastline|bathy)\/(\d+)\/(\d+)\/(\d+)\.(pbf|png)/)
    if (m && existing.has(`${m[1]}:${m[2]}/${m[3]}/${m[4]}`)) {
      res.setHeader('content-type', m[1] === 'coastline' ? 'application/x-protobuf' : 'image/png')
      res.end('TILE')
    } else { res.statusCode = 404; res.end('empty') }
  })
  return { srv, hits: () => hits }
}

test('seeder: parent-guided descent visits exactly non-empty coastline tiles + is idempotent', async () => {
  const existing = new Set([
    'bathy:0/0/0',
    'coastline:0/0/0',
    'coastline:1/0/0', 'coastline:1/1/1', // 2 of z0's 4 children
    'coastline:2/0/0', // child of (1,0,0)
    'coastline:2/3/3' //  child of (1,1,1)
  ])
  const u = sparseUpstream(existing)
  await listen(u.srv)
  const up = `http://127.0.0.1:${u.srv.address().port}`
  const storeDir = tmpStore()

  const s = createSeeder(app, { upstream: up, storeDir, coastlineMaxZoom: 2, seabedMaxZoom: 0, concurrency: 3, offlinePollMs: 10 })
  await s.start()
  const c = s._counts()
  assert.strictEqual(c.coastline, 5, '5 non-empty coastline tiles found')
  assert.strictEqual(c.seabed, 1, '1 seabed tile')
  assert.strictEqual(c.failed, 0)
  // requests: seabed 1 + coastline [z0:1, z0 children:4, existing-z1(2)*4 children:8] = 13
  const firstHits = u.hits()
  assert.strictEqual(firstHits, 1 + 13, 'probed root + children of non-empty tiles only')

  // idempotent: a second run makes ZERO network calls (real HITs + 404 sentinels)
  const s2 = createSeeder(app, { upstream: up, storeDir, coastlineMaxZoom: 2, seabedMaxZoom: 0, concurrency: 3, offlinePollMs: 10 })
  await s2.start()
  assert.strictEqual(u.hits(), firstHits, 're-seed hits cache only, no network')
  assert.strictEqual(s2._counts().coastline, 5, 'still finds the 5 from cache')

  await new Promise((r) => u.srv.close(r))
})

test('seeder: parks while the circuit breaker is open (offline), resumes when it clears', async () => {
  const u = sparseUpstream(new Set(['bathy:0/0/0', 'coastline:0/0/0']))
  await listen(u.srv)
  const up = `http://127.0.0.1:${u.srv.address().port}`
  const health = { downUntil: Date.now() + 60000, cooldownMs: 15000 } // start "offline"

  const s = createSeeder(app, { upstream: up, storeDir: tmpStore(), coastlineMaxZoom: 0, seabedMaxZoom: 0, concurrency: 2, health, offlinePollMs: 15 })
  s.start()
  await new Promise((r) => setTimeout(r, 80))
  assert.strictEqual(u.hits(), 0, 'no fetches while breaker open')

  health.downUntil = 0 // back online
  await s._wait()
  assert.ok(u.hits() > 0, 'resumed after breaker cleared')
  assert.strictEqual(s._counts().seabed, 1)

  await new Promise((r) => u.srv.close(r))
})

// ---------- region prefetch ----------
function callRegion (proxy, body) {
  const fakeReq = () => {
    const l = {}
    const r = { setEncoding () {}, on (ev, cb) { l[ev] = cb; if (ev === 'end') setImmediate(() => { l.data && l.data(JSON.stringify(body)); l.end && l.end() }); return r } }
    return r
  }
  return new Promise((resolve) => {
    const res = { statusCode: 200, status (c) { this.statusCode = c; return this }, json (o) { this.jsonBody = o; resolve(this) } }
    proxy.handlePrefetchRegion(fakeReq(), res)
  })
}

test('region prefetch: warms the bbox rectangle; caps oversized requests without fetching', async () => {
  let hits = 0
  const srv = http.createServer((req, res) => { hits++; res.setHeader('content-type', 'image/png'); res.end('T') })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const proxy = createProxy(app, { sailkickUrl: up, proxyPort: 0, storeDir: tmpStore(), manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()

  const bbox = [-74.05, 40.70, -73.95, 40.80]
  const expected = countBboxTiles(bbox, 10, 11) // one layer
  const r = await callRegion(proxy, { bbox, minZoom: 10, maxZoom: 11, layers: ['bathy'] })
  assert.strictEqual(r.statusCode, 200)
  assert.strictEqual(r.jsonBody.ok, true)
  assert.strictEqual(r.jsonBody.requested, expected, 'enumerated the rectangle')
  assert.strictEqual(r.jsonBody.cached, expected, 'all warmed')
  assert.strictEqual(hits, expected)

  // oversized: global z0-15 across 4 layers → capped, no fetching
  const before = hits
  const cap = await callRegion(proxy, { bbox: [-180, -85, 180, 85], minZoom: 0, maxZoom: 15 })
  assert.strictEqual(cap.jsonBody.capped, true)
  assert.ok(cap.jsonBody.estimate > 50000)
  assert.strictEqual(hits, before, 'capped request fetched nothing')

  // bad bbox → 400
  const bad = await callRegion(proxy, { bbox: [1, 2, 3] })
  assert.strictEqual(bad.statusCode, 400)

  proxy.stop()
  await new Promise((r) => srv.close(r))
})
