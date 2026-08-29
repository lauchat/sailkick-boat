'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const fs = require('node:fs')
const { getResource, storePaths } = require('../lib/proxy/cache')

let seq = 0
const tmpStore = () => path.join(os.tmpdir(), `sk-strat-${process.pid}-${seq++}`)
const listen = (srv) => new Promise((r) => srv.listen(0, r))

test('networkFirst: serves LIVE each time online, STALE from cache when offline', async () => {
  let ver = 'A'
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ v: ver })) })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()

  let r = await getResource({ storeDir, upstream: up, reqPath: '/api/ais', networkFirst: true })
  assert.strictEqual(r.cacheState, 'LIVE')
  assert.strictEqual(JSON.parse(r.buffer).v, 'A')

  ver = 'B' // upstream changes — network-first must reflect it, not serve the cached 'A'
  r = await getResource({ storeDir, upstream: up, reqPath: '/api/ais', networkFirst: true })
  assert.strictEqual(r.cacheState, 'LIVE')
  assert.strictEqual(JSON.parse(r.buffer).v, 'B', 'live data is fresh, never pinned')

  await new Promise((res) => srv.close(res)) // go offline
  r = await getResource({ storeDir, upstream: up, reqPath: '/api/ais', networkFirst: true, timeoutMs: 800 })
  assert.strictEqual(r.cacheState, 'STALE', 'offline → falls back to last cached copy')
  assert.strictEqual(JSON.parse(r.buffer).v, 'B')
})

test('circuit breaker: after one offline failure, uncached requests fast-fail (no timeout hang)', async () => {
  const storeDir = tmpStore()
  const health = { downUntil: 0, cooldownMs: 15000 }
  const badUpstream = 'http://127.0.0.1:1' // nothing listening

  // first uncached miss actually attempts the fetch and fails → trips the breaker
  const t0 = process.hrtime.bigint()
  await assert.rejects(() => getResource({ storeDir, upstream: badUpstream, reqPath: '/tiles/x/1/2/3.png', timeoutMs: 1500, health }), (e) => e.offline === true)
  const firstMs = Number(process.hrtime.bigint() - t0) / 1e6
  assert.ok(health.downUntil > Date.now(), 'breaker tripped')

  // subsequent uncached miss must fast-fail WITHOUT waiting for the timeout again
  const t1 = process.hrtime.bigint()
  await assert.rejects(() => getResource({ storeDir, upstream: badUpstream, reqPath: '/tiles/x/9/9/9.png', timeoutMs: 1500, health }), (e) => e.offline === true)
  const secondMs = Number(process.hrtime.bigint() - t1) / 1e6
  assert.ok(secondMs < 100, `fast-fail while breaker open (was ${secondMs.toFixed(0)}ms)`)
  assert.ok(secondMs < firstMs, 'second attempt is much faster than the first')
})

test('circuit breaker: cached HIT still serves instantly while the breaker is open', async () => {
  // seed a cached tile via a live upstream, then trip the breaker and confirm HIT still works
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'image/png'); res.end('PNGDATA') })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()
  const health = { downUntil: 0, cooldownMs: 15000 }

  const miss = await getResource({ storeDir, upstream: up, reqPath: '/tiles/osm/5/5/5.png', health })
  assert.strictEqual(miss.cacheState, 'MISS')

  health.downUntil = Date.now() + 15000 // simulate breaker open (offline)
  const hit = await getResource({ storeDir, upstream: up, reqPath: '/tiles/osm/5/5/5.png', health })
  assert.strictEqual(hit.cacheState, 'HIT', 'cached tile serves from disk even with breaker open')
  assert.strictEqual(hit.buffer.toString(), 'PNGDATA')

  await new Promise((res) => srv.close(res))
})

test('circuit breaker: a successful fetch clears the breaker', async () => {
  const srv = http.createServer((req, res) => res.end('ok'))
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()
  const health = { downUntil: Date.now() + 15000, cooldownMs: 15000 } // start "open"

  // networkFirst request while open + no cache → fast-fails
  await assert.rejects(() => getResource({ storeDir, upstream: up, reqPath: '/api/x', networkFirst: true, health }), (e) => e.offline === true)

  // once we let a real fetch through (breaker window elapsed), success clears it
  health.downUntil = 0
  const r = await getResource({ storeDir, upstream: up, reqPath: '/api/x', networkFirst: true, health })
  assert.strictEqual(r.cacheState, 'LIVE')
  assert.strictEqual(health.downUntil, 0, 'breaker cleared after a success')

  await new Promise((res) => srv.close(res))
})

// --- velocity tiles are pinned, not network-first (v0.14.5) ----------------------
// The app moved velocity + lightning behind its own origin (/api/velocity,
// /api/lightning). Velocity TILES embed the forecast run id in the path, so a URL's
// bytes never change — pinning them is what makes the wind field work offline. The
// manifest resolves run=latest and must stay live, or the boat sticks to a stale run.
const { isNetworkFirst, isImmutableApi } = require('../lib/proxy')

test('strategy split: velocity tiles pinned, everything else under /api live', () => {
  const pinned = [
    '/api/velocity/tiles/wind/2026080100/3/4/5/12.f32',
    '/api/velocity/tiles/current/2026073118/0/0/0/0.f32'
  ]
  const live = [
    '/api/velocity/manifest?layer=wind&run=latest', // must NOT pin — resolves "latest"
    '/api/lightning/lightning?bbox=1,2,3,4&since=3600',
    '/api/ais', '/api/config', '/api/wind', '/api/forecast', '/api/assets'
  ]
  // /index.html and /health moved to network-first in v0.18.4 — see the entry-document
  // test below. Only immutable-by-URL content stays pinned.
  const cacheFirst = ['/tiles/bathy/3/4/5.png', '/terrain/layer.json', '/assets/main-abc.js']

  for (const p of pinned) {
    assert.ok(isImmutableApi(p), `${p} is immutable`)
    assert.strictEqual(isNetworkFirst(p), false, `${p} must be cache-first`)
  }
  for (const p of live) {
    assert.strictEqual(isNetworkFirst(p), true, `${p} must stay network-first`)
    assert.strictEqual(isImmutableApi(p), false, `${p} is not immutable`)
  }
  for (const p of cacheFirst) {
    assert.strictEqual(isNetworkFirst(p), false, `${p} is not an /api path`)
  }
})

test('a velocity tile is served from disk offline, and only fetched once online', async () => {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    res.setHeader('content-type', 'application/octet-stream')
    res.end(Buffer.from([1, 2, 3, 4]))
  })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()
  const reqPath = '/api/velocity/tiles/wind/2026080100/3/4/5/12.f32'
  const opts = { storeDir, upstream: up, reqPath, networkFirst: isNetworkFirst(reqPath) }

  let r = await getResource(opts)
  assert.strictEqual(r.cacheState, 'MISS')
  assert.strictEqual(hits, 1)

  r = await getResource(opts)
  assert.strictEqual(r.cacheState, 'HIT', 'panning again must not refetch the whole wind field')
  assert.strictEqual(hits, 1, 'still one upstream request')

  await new Promise((res) => srv.close(res)) // uplink down
  r = await getResource({ ...opts, timeoutMs: 800 })
  assert.strictEqual(r.cacheState, 'HIT', 'wind field still renders offline')
  assert.deepStrictEqual([...r.buffer], [1, 2, 3, 4])
})

test('a bake announcement does not churn immutable velocity tiles', async () => {
  let body = 'first'
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/octet-stream'); res.end(body) })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()
  const reqPath = '/api/velocity/tiles/wind/2026080100/1/1/1/0.f32'

  await getResource({ storeDir, upstream: up, reqPath, networkFirst: false })
  body = 'second'
  // The mirror passes invalidatedAt:0 for immutable paths even when the app id changes.
  const r = await getResource({ storeDir, upstream: up, reqPath, networkFirst: false, invalidatedAt: 0 })
  assert.strictEqual(r.cacheState, 'HIT')
  assert.strictEqual(r.buffer.toString(), 'first', 'run-keyed bytes are never re-fetched')
  await new Promise((res) => srv.close(res))
})

// --- the app shell must not be pinned (v0.18.4) -------------------------------------
// Content-hashed assets can be pinned forever because a new build gives them new URLs.
// index.html is the one file whose URL never changes, so pinning it keeps a boat on
// whatever version it cached first — which is exactly what happened: the cache manifest
// announces an `app` id that is the package version, and three deploys in one day all
// reported "0.2.0", so nothing was ever invalidated.
const { isEntryDocument } = require('../lib/proxy')

test('strategy: entry documents are live, hashed assets stay pinned', () => {
  for (const p of ['/', '/index.html', '/mobile/', '/manifest.webmanifest']) {
    assert.strictEqual(isEntryDocument(p), true, `${p} is an entry document`)
    assert.strictEqual(isNetworkFirst(p), true, `${p} must be fetched fresh`)
  }
  for (const p of ['/assets/main-Cm1RhM4y.js', '/assets/main-BboaeyYc.css', '/tiles/bathy/3/4/5.png', '/cesium/Cesium.js', '/terrain/layer.json']) {
    assert.strictEqual(isNetworkFirst(p), false, `${p} must stay pinned`)
  }
})

test('a redeployed app shell reaches the boat, and still opens offline', async () => {
  let html = '<html><script src="/assets/main-OLD.js"></script></html>'
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', req.url.endsWith('.js') ? 'application/javascript' : 'text/html')
    res.end(req.url.endsWith('.js') ? `// ${req.url}` : html)
  })
  await listen(srv)
  const up = `http://127.0.0.1:${srv.address().port}`
  const storeDir = tmpStore()
  const opts = { storeDir, upstream: up, reqPath: '/', networkFirst: isNetworkFirst('/') }

  let r = await getResource(opts)
  assert.match(r.buffer.toString(), /main-OLD\.js/)

  // the cloud redeploys; the manifest `app` id does NOT change (the bug this works around)
  html = '<html><script src="/assets/main-NEW.js"></script></html>'
  r = await getResource(opts)
  assert.strictEqual(r.cacheState, 'LIVE')
  assert.match(r.buffer.toString(), /main-NEW\.js/, 'the boat picks up the new build with no invalidation signal')

  await new Promise((res) => srv.close(res)) // go to sea
  r = await getResource({ ...opts, timeoutMs: 600 })
  assert.strictEqual(r.cacheState, 'STALE')
  assert.match(r.buffer.toString(), /main-NEW\.js/, 'and the last-seen shell still opens offline')
})

// --- a pinned tile that was cached COMPRESSED (v0.28.0) ------------------------------
// The pre-0.23.9 transport stored still-gzipped bytes as if they were the payload; Cesium
// read the gzip header as a vertex count ("Invalid typed array length: 11239580910").
// Fixing the transport did not fix the cache: tiles are pinned, so 2,391 terrain tiles and
// 188 vector tiles on this boat kept throwing for weeks after. Nothing ever re-examined a
// stored file. Now a HIT is checked — two bytes of a buffer already read.
const { isCorruptOnDisk } = require('../lib/proxy/cache')

test('cache: recognises gzip bytes stored as a payload, and leaves real gzip alone', () => {
  const gz = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
  const mesh = Buffer.from([0x48, 0xad, 0x5d, 0x24])
  assert.strictEqual(isCorruptOnDisk({ buffer: gz, contentType: 'application/vnd.quantized-mesh' }, '/terrain/8/216/59.terrain'), true)
  assert.strictEqual(isCorruptOnDisk({ buffer: gz, contentType: 'application/x-protobuf' }, '/tiles/x/1/2/3.pbf'), true)
  assert.strictEqual(isCorruptOnDisk({ buffer: mesh, contentType: 'application/vnd.quantized-mesh' }, '/terrain/8/216/59.terrain'), false)
  // …but a gzip FILE is content, not an encoding, and must not be touched.
  assert.strictEqual(isCorruptOnDisk({ buffer: gz, contentType: 'application/gzip' }, '/assets/dem.gz'), false)
  assert.strictEqual(isCorruptOnDisk({ buffer: gz, contentType: 'application/octet-stream' }, '/assets/dem.gz'), false)
  assert.strictEqual(isCorruptOnDisk({ buffer: Buffer.alloc(0), contentType: 'text/plain' }, '/x'), false)
})

test('cache: a corrupt pinned tile is replaced on the next request, not served again', async () => {
  const store = tmpStore()
  let served = 0
  const up = http.createServer((req, res) => {
    served++
    res.setHeader('Content-Type', 'application/vnd.quantized-mesh')
    res.end(Buffer.from([0x48, 0xad, 0x5d, 0x24, 0x01, 0x02, 0x03, 0x04]))
  })
  await new Promise((r) => up.listen(0, r))
  const upstream = `http://127.0.0.1:${up.address().port}`
  const reqPath = '/terrain/8/216/59.terrain'

  // plant a poisoned cache entry, exactly as the old transport left them
  const { file, meta } = storePaths(store, reqPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]))
  fs.writeFileSync(meta, 'application/vnd.quantized-mesh')

  // finally: a failed assertion must not skip up.close() and hang the file — the same
  // trap that has now bitten three test files in this repo.
  try {
    const r = await getResource({ storeDir: store, upstream, reqPath })
    assert.strictEqual(r.cacheState, 'REPAIRED', 'reported as a repair, not a plain HIT')
    assert.strictEqual(r.buffer[0], 0x48, 'the clean copy is served')
    assert.strictEqual(served, 1, 'it went back to the upstream')
    assert.strictEqual(fs.readFileSync(file)[0], 0x48, 'and the poisoned file is gone from disk')

    // second request is an ordinary HIT again — the repair is not repeated
    const again = await getResource({ storeDir: store, upstream, reqPath })
    assert.strictEqual(again.cacheState, 'HIT')
    assert.strictEqual(served, 1)
  } finally { up.close() }
})

test('cache: offline with a corrupt copy FAILS rather than serving the poison again', async () => {
  // A renderer handed a gzip header errors hard; a missing tile just falls back to its
  // parent. Failing is the better of the two.
  const store = tmpStore()
  const reqPath = '/terrain/5/1/2.terrain'
  const { file, meta } = storePaths(store, reqPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))
  fs.writeFileSync(meta, 'application/vnd.quantized-mesh')
  await assert.rejects(
    getResource({ storeDir: store, upstream: 'http://127.0.0.1:1', reqPath }),
    (e) => e instanceof Error)
  assert.ok(!fs.existsSync(file), 'the corrupt file is dropped either way, so a later online request repairs it')
})
