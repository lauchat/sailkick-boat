'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const { createHistory } = require('../lib/history')
const { createProxy } = require('../lib/proxy')

const app = { debug () {} }

// Local history has exactly one source: the ring, sampled from live BoatState. Until
// v0.15.0 a configured InfluxDB read token displaced it — which for a bucket of older
// data meant Trends served nothing (the app only ever asks for a relative window,
// clamped to 24 h) while the working live ring sat switched off. These tests pin the
// source down so that cannot come back.
const fakeSource = (state) => ({ getState: () => state })
const ringOpts = (state) => ({ ringSource: fakeSource(state), ringSampleSec: 99999, ringPersist: false })
const LIVE = { sogKt: 5, cogDeg: 90, headingDeg: 88, awsKt: 12, awaDeg: 40, depthM: 18, lat: 36.95, lon: -76.19 }

const capture = () => ({
  statusCode: 200,
  headers: {},
  body: '',
  writableFinished: false,
  on () {},
  setHeader (k, v) { this.headers[k] = v },
  end (b) { this.body = b || ''; this.writableFinished = true }
})

test('history: available() gates on having a telemetry source, not on a token', () => {
  const none = createHistory(app, {}); none.start()
  assert.strictEqual(none.available(), false, 'no telemetry → falls through to the mirror')

  const ring = createHistory(app, ringOpts(LIVE)); ring.start()
  assert.strictEqual(ring.available(), true, 'telemetry alone is enough — no database needed')
  ring.stop()
})

test('history: an InfluxDB token in the config no longer changes the source', async () => {
  const h = createHistory(app, { ...ringOpts(LIVE), token: 'STALE', bucket: 'bandg', influxUrl: 'http://127.0.0.1:1' })
  h.start()
  const res = capture()
  await h.handleSeries({ url: '/api/history/series?window=3600s&every=30s' }, res)
  // :1 has nothing listening — reaching it would hang or 502 rather than answer.
  assert.strictEqual(res.statusCode, 200, 'no attempt to query the configured InfluxDB')
  assert.ok(JSON.parse(res.body).series.sog, 'served live from the ring')
  h.stop()
})

test('history: handleSeries returns the app JSON envelope; 503 when unavailable', async () => {
  const h = createHistory(app, ringOpts(LIVE)); h.start()
  const res = capture()
  await h.handleSeries({ url: '/api/history/series?window=1800s&every=15s' }, res)
  assert.strictEqual(res.statusCode, 200)
  const j = JSON.parse(res.body)
  assert.strictEqual(j.ok, true)
  assert.strictEqual(j.windowSec, 1800, 'window echoed back')
  assert.strictEqual(j.everySec, 15)
  assert.ok(typeof j.from === 'number' && typeof j.to === 'number', 'from/to present')
  assert.ok(j.series && typeof j.series === 'object')
  h.stop()

  const off = createHistory(app, {}); off.start()
  const res2 = capture()
  await off.handleSeries({ url: '/api/history/series' }, res2)
  assert.strictEqual(res2.statusCode, 503)
  assert.strictEqual(JSON.parse(res2.body).code, 'history-unavailable')
})

test('history: handleTrack returns ordered points from the ring', async () => {
  const h = createHistory(app, ringOpts(LIVE)); h.start()
  const res = capture()
  await h.handleTrack({ url: '/api/history/track?window=3600s' }, res)
  assert.strictEqual(res.statusCode, 200)
  const j = JSON.parse(res.body)
  assert.strictEqual(j.ok, true)
  assert.ok(Array.isArray(j.track))
  if (j.track.length) {
    assert.ok(Number.isFinite(j.track[0].lat) && Number.isFinite(j.track[0].lon))
    assert.ok(Number.isFinite(j.track[0].t))
  }
  h.stop()
})

test('proxy: routes /api/history to local history when available, else mirrors', async () => {
  const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, from: 'CLOUD-MIRROR' })) })
  await new Promise((r) => upstream.listen(0, r))
  const upPort = upstream.address().port

  const callTrack = (proxy) => new Promise((resolve) => {
    const req = { url: '/api/history/track?window=3600s', method: 'GET', headers: {} }
    const res = { statusCode: 200, headers: {}, chunks: '', on () {}, setHeader (k, v) { this.headers[k] = v }, writableFinished: false, end (b) { this.chunks = b || ''; this.writableFinished = true; resolve(this) } }
    proxy._serveMirror(req, res)
  })

  // telemetry present → served locally from the ring
  const h = createHistory(app, ringOpts(LIVE)); h.start()
  const proxy = createProxy(app, { sailkickUrl: `http://127.0.0.1:${upPort}`, proxyPort: 0, history: h, storeDir: '/tmp/sk-hist-test-store', manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()
  const local = JSON.parse((await callTrack(proxy)).chunks)
  assert.ok(local.ok && Array.isArray(local.track), 'served from local history')
  // NB: `from` is now a real field on our own answer too — it echoes the start of the
  // range served (v0.24.0) — so the mirror is identified by its VALUE, not its presence.
  assert.notStrictEqual(local.from, 'CLOUD-MIRROR', 'did NOT come from the cloud mirror')

  // no telemetry → falls through to the mirror, so an online boat is never worse off
  const hoff = createHistory(app, {}); hoff.start()
  const proxy2 = createProxy(app, { sailkickUrl: `http://127.0.0.1:${upPort}`, proxyPort: 0, history: hoff, storeDir: '/tmp/sk-hist-test-store2', manifest: { enabled: false }, seed: { enabled: false } })
  proxy2.start()
  const fell = JSON.parse((await callTrack(proxy2)).chunks)
  assert.strictEqual(fell.from, 'CLOUD-MIRROR', 'unavailable history falls through to the mirror')

  h.stop(); proxy.stop(); proxy2.stop(); upstream.close()
})
