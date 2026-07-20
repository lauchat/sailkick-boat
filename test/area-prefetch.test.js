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
  const srv = http.createServer((req, res) => { hits++; res.setHeader('content-type', req.url.endsWith('.pbf') ? 'application/x-protobuf' : 'image/png'); res.end('T') })
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
  const srv = http.createServer((req, res) => { hits++; res.end('T') })
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
