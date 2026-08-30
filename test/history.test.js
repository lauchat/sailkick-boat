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

// The two additive params, end to end through the handler (v0.29.0). The app sends
// `stats=1&chans=sog,aws,depth` for the mobile sparklines and `stats=1&chans=<one>` for
// the history sheet and the desktop flyout; a client that sends neither must get exactly
// what it got before.
const callSeries = (h, url) => new Promise((resolve) => {
  const res = capture()
  res.end = (b) => { res.body = b || ''; res.writableFinished = true; resolve(JSON.parse(res.body)) }
  h.handleSeries({ url, method: 'GET', headers: {} }, res)
})

test('history: stats=1 adds bands, and only for channels that can have one', async () => {
  const h = createHistory(app, ringOpts(LIVE)); h.start()
  h._provider()._sample() // a second row, so a bucket has something to span

  const asked = await callSeries(h, '/api/history/series?window=600s&every=60s&stats=1&chans=sog,cog')
  assert.ok(asked.bands, 'bands present when asked')
  assert.ok(asked.bands.sog, 'sog is linear — it gets one')
  assert.strictEqual(asked.bands.cog, undefined, 'cog is a compass bearing — it never does')
  assert.deepStrictEqual(Object.keys(asked.series).sort(), ['cog', 'sog'], 'chans narrowed the answer')
  assert.strictEqual(asked.bands.sog[0].length, 3, '[t, min, max]')

  const plain = await callSeries(h, '/api/history/series?window=600s&every=60s&chans=sog,cog')
  assert.strictEqual(plain.bands, undefined, 'no stats param, no bands key at all')
  assert.deepStrictEqual(plain.series, asked.series, 'the mean line is the same either way')
  h.stop()
})

test('history: `every` is honoured and floored so one answer stays drawable', async () => {
  const h = createHistory(app, ringOpts(LIVE)); h.start()
  const r = await callSeries(h, '/api/history/series?window=3600s&every=60s')
  assert.strictEqual(r.everySec, 60, 'echoed back')

  // A month-wide absolute range at the default 30 s would be 86,400 points; the floor
  // brings it back to ~3k, exactly as the cloud route does.
  const to = Date.now()
  const from = to - 30 * 86400 * 1000
  const wide = await callSeries(h, `/api/history/series?from=${from}&to=${to}`)
  assert.ok(wide.everySec >= Math.ceil((30 * 86400) / 3000), `floored to ${wide.everySec}s`)
  assert.strictEqual(wide.from, from, 'and the requested range is still what was served')
  h.stop()
})

test('history: the route refuses to forward bands the client did not ask for', async () => {
  // The provider guards this too, so removing the route's own check broke no test. The
  // contract is the route's: bands appear only when stats was asked AND the provider
  // produced them, so a provider that always returns them must not leak them.
  const h = createHistory(app, ringOpts(LIVE)); h.start()
  h._provider().getSeries = () => ({ ok: true, series: { sog: [[1, 5]] }, bands: { sog: [[1, 4, 6]] } })

  const plain = await callSeries(h, '/api/history/series?window=600s')
  assert.strictEqual(plain.bands, undefined, 'not asked for, not forwarded')
  const asked = await callSeries(h, '/api/history/series?window=600s&stats=1')
  assert.deepStrictEqual(asked.bands, { sog: [[1, 4, 6]] }, 'asked for, forwarded verbatim')
  h.stop()
})

test('history: stats=1 with a provider that cannot produce bands still returns the line', async () => {
  // "bands may be absent even when asked" — every client degrades to the mean line.
  const h = createHistory(app, ringOpts(LIVE)); h.start()
  h._provider().getSeries = () => ({ ok: true, series: { sog: [[1, 5]] } })
  const r = await callSeries(h, '/api/history/series?window=600s&stats=1')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.series.sog, [[1, 5]])
  assert.strictEqual(r.bands, undefined)
  h.stop()
})
