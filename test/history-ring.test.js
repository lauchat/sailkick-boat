'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { RingHistoryProvider } = require('../lib/history/ring')
const { createHistory } = require('../lib/history')

const app = { debug () {} }

// A telemetry-like source whose getState() returns a scripted BoatState.
function fakeSource (initial) {
  let s = initial
  return { set (v) { s = v }, getState () { return s } }
}

test('ring: samples BoatState into series (with derived tws/twd) + ordered track', () => {
  const src = fakeSource(null)
  const ring = new RingHistoryProvider({ source: src, windowSec: 3600, sampleSec: 99999 })
  // no fix yet → constructor sample is a no-op
  assert.deepStrictEqual(ring.getSeries({ windowSec: 3600 }).series, {})

  src.set({ sogKt: 5, cogDeg: 90, headingDeg: 0, awsKt: 10, awaDeg: 90, depthM: 12, lat: 40, lon: -74 })
  ring._sample()
  src.set({ sogKt: 6, cogDeg: 92, headingDeg: 10, awsKt: 11, awaDeg: 80, depthM: 13, lat: 40.01, lon: -74.01 })
  ring._sample()

  const { series } = ring.getSeries({ windowSec: 3600 })
  for (const ch of ['sog', 'heading', 'aws', 'awa', 'depth', 'tws', 'twd']) {
    assert.ok(Array.isArray(series[ch]) && series[ch].length === 2, `channel ${ch} has 2 points`)
    assert.strictEqual(series[ch][0].length, 2, '[tMs, value] pairs')
  }
  assert.ok(series.tws[0][1] > 0, 'true wind derived from apparent + motion')

  const { track } = ring.getTrack({ windowSec: 3600 })
  assert.strictEqual(track.length, 2)
  assert.ok(track[0].t <= track[1].t, 'ordered by time')
  assert.ok(Math.abs(track[1].lat - 40.01) < 1e-9 && Math.abs(track[1].lon + 74.01) < 1e-9)
  ring.destroy()
})

test('ring: window trims samples older than windowSec', () => {
  const src = fakeSource({ sogKt: 3, cogDeg: 0, headingDeg: 0, awsKt: null, awaDeg: null, lat: 1, lon: 2 })
  const ring = new RingHistoryProvider({ source: src, windowSec: 3600, sampleSec: 99999 })
  // the constructor already took one sample — age every sample past the window
  ring._ring.forEach((r) => { r.t -= 2 * 3600 * 1000 })
  assert.strictEqual(ring.getSeries({ windowSec: 3600 }).series.sog, undefined, 'stale sample excluded')
  assert.strictEqual(ring.getTrack({ windowSec: 3600 }).track.length, 0)
  ring.destroy()
})

test('history: picks the ring when no InfluxDB token but a telemetry source exists', async () => {
  const src = fakeSource({ sogKt: 4, cogDeg: 10, headingDeg: 5, awsKt: 8, awaDeg: 60, depthM: 20, lat: 36.9, lon: -76.3 })
  const h = createHistory(app, { token: '', ringSource: src, ringSampleSec: 99999 })
  h.start()
  assert.strictEqual(h.available(), true, 'ring makes history available without a DB')
  assert.strictEqual(h._mode(), 'ring')

  const cap = () => ({ statusCode: 200, headers: {}, body: '', writableFinished: false, on () {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b || ''; this.writableFinished = true } })
  const res = cap()
  await h.handleSeries({ url: '/api/history/series?window=3600s&every=30s' }, res)
  const j = JSON.parse(res.body)
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(j.ok, true)
  assert.strictEqual(j.windowSec, 3600)
  assert.ok(j.series.sog && j.series.heading, 'served from the ring')
  h.stop()
})

test('history: prefers InfluxDB when a token is configured (ring not used)', () => {
  const src = fakeSource({ sogKt: 4, lat: 1, lon: 2 })
  const h = createHistory(app, { token: 't', bucket: 'bandg', influxUrl: 'http://127.0.0.1:1', ringSource: src })
  h.start()
  assert.strictEqual(h._mode(), 'influx', 'token present → InfluxDB, not ring')
  assert.strictEqual(h.available(), true)
  h.stop()
})

test('history: unavailable when neither InfluxDB nor a telemetry source is present', async () => {
  const h = createHistory(app, { token: '' }) // no ringSource
  h.start()
  assert.strictEqual(h.available(), false)
  const res = { statusCode: 200, headers: {}, body: '', writableFinished: false, on () {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b || ''; this.writableFinished = true } }
  await h.handleSeries({ url: '/api/history/series' }, res)
  assert.strictEqual(res.statusCode, 503)
  h.stop()
})
