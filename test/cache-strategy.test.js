'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { getResource } = require('../lib/proxy/cache')

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
