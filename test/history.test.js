'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const { createHistory } = require('../lib/history')
const { createProxy } = require('../lib/proxy')

const app = { debug () {} }

// A fake InfluxDB /api/v2/query that returns annotated CSV for whichever query
// shape it recognises (series vs track), so we exercise the real Flux→JSON path.
function fakeInflux () {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/csv')
      if (body.includes('pivot')) {
        // track query → position pivot with lat/lon columns
        res.end(
          '#datatype,string,long,dateTime:RFC3339,double,double\r\n' +
          ',result,table,_time,lat,lon\r\n' +
          ',_result,0,2026-07-19T10:00:00Z,36.95,-76.19\r\n' +
          ',_result,0,2026-07-19T10:00:30Z,36.96,-76.18\r\n'
        )
      } else {
        // series query → long format with _measurement + _value
        res.end(
          '#datatype,string,long,dateTime:RFC3339,double,string\r\n' +
          ',result,table,_time,_value,_measurement\r\n' +
          ',_result,0,2026-07-19T10:00:00Z,5,navigation.speedOverGround\r\n' +
          ',_result,1,2026-07-19T10:00:30Z,6,navigation.speedOverGround\r\n' +
          ',_result,2,2026-07-19T10:00:00Z,1.5707963,navigation.headingTrue\r\n'
        )
      }
    })
  })
  return srv
}

test('history: available() gates on token/url/bucket', () => {
  const h1 = createHistory(app, { token: '' }); h1.start()
  assert.strictEqual(h1.available(), false, 'no token → not available')
  const h2 = createHistory(app, { token: 't', bucket: 'bandg', influxUrl: 'http://x' }); h2.start()
  assert.strictEqual(h2.available(), true)
})

test('history: getSeries maps measurements→channels with unit conversion', async () => {
  const influx = fakeInflux()
  await new Promise((r) => influx.listen(0, r))
  const port = influx.address().port
  const h = createHistory(app, { token: 't', bucket: 'bandg', influxUrl: `http://127.0.0.1:${port}` })
  h.start()
  const r = await h._getSeries({ windowSec: 3600, everySec: 30 })
  assert.ok(r.ok)
  assert.ok(r.series.sog, 'sog channel present')
  assert.ok(Math.abs(r.series.sog[0][1] - 5 * 1.94384) < 1e-3, '5 m/s → knots')
  assert.ok(r.series.heading, 'heading channel present')
  assert.ok(Math.abs(r.series.heading[0][1] - 90) < 0.01, 'pi/2 rad → 90°')
  influx.close()
})

test('history: getTrack pivots lat/lon into ordered points', async () => {
  const influx = fakeInflux()
  await new Promise((r) => influx.listen(0, r))
  const port = influx.address().port
  const h = createHistory(app, { token: 't', bucket: 'bandg', influxUrl: `http://127.0.0.1:${port}` })
  h.start()
  const r = await h._getTrack({ windowSec: 3600 })
  assert.ok(r.ok)
  assert.strictEqual(r.track.length, 2)
  assert.ok(Math.abs(r.track[0].lat - 36.95) < 1e-9 && Math.abs(r.track[0].lon + 76.19) < 1e-9)
  assert.ok(r.track[0].t < r.track[1].t, 'sorted by time')
  influx.close()
})

test('history: handleSeries returns the app JSON envelope; 503 when unavailable', async () => {
  const influx = fakeInflux()
  await new Promise((r) => influx.listen(0, r))
  const port = influx.address().port
  const h = createHistory(app, { token: 't', bucket: 'bandg', influxUrl: `http://127.0.0.1:${port}` })
  h.start()
  const cap = () => {
    const res = { statusCode: 200, headers: {}, body: '', writableFinished: false, on () {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b || ''; this.writableFinished = true } }
    return res
  }
  const ok = cap()
  await h.handleSeries({ url: '/api/history/series?window=3600s&every=30s' }, ok)
  const j = JSON.parse(ok.body)
  assert.strictEqual(ok.statusCode, 200)
  assert.strictEqual(j.ok, true)
  assert.strictEqual(j.windowSec, 3600)
  assert.strictEqual(j.everySec, 30)
  assert.ok(j.series.sog && j.series.heading)

  const off = createHistory(app, { token: '' }); off.start()
  const r503 = cap()
  await off.handleSeries({ url: '/api/history/series' }, r503)
  assert.strictEqual(r503.statusCode, 503)
  assert.strictEqual(JSON.parse(r503.body).code, 'history-unavailable')
  influx.close()
})

test('proxy: routes /api/history to local history when available, else mirrors', async () => {
  // upstream mirror that would answer /api/history if we fell through
  const upstream = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, from: 'CLOUD-MIRROR' })) })
  await new Promise((r) => upstream.listen(0, r))
  const upPort = upstream.address().port

  const influx = fakeInflux()
  await new Promise((r) => influx.listen(0, r))
  const inPort = influx.address().port

  // history CONFIGURED → served locally
  const h = createHistory(app, { token: 't', bucket: 'bandg', influxUrl: `http://127.0.0.1:${inPort}` }); h.start()
  const proxy = createProxy(app, { sailkickUrl: `http://127.0.0.1:${upPort}`, proxyPort: 0, history: h, storeDir: '/tmp/sk-hist-test-store', manifest: { enabled: false } })
  proxy.start()
  const local = await new Promise((resolve) => {
    const req = { url: '/api/history/track?window=3600s', method: 'GET', headers: {} }
    const res = { statusCode: 200, headers: {}, chunks: '', on () {}, setHeader (k, v) { this.headers[k] = v }, writableFinished: false, end (b) { this.chunks = b || ''; this.writableFinished = true; resolve(this) } }
    proxy._serveMirror(req, res)
  })
  const lj = JSON.parse(local.chunks)
  assert.ok(lj.ok && Array.isArray(lj.track), 'served from local history (has track array)')
  assert.ok(!lj.from, 'did NOT come from the cloud mirror')

  // history UNCONFIGURED → falls through to mirror
  const hoff = createHistory(app, { token: '' }); hoff.start()
  const proxy2 = createProxy(app, { sailkickUrl: `http://127.0.0.1:${upPort}`, proxyPort: 0, history: hoff, storeDir: '/tmp/sk-hist-test-store2', manifest: { enabled: false } })
  proxy2.start()
  const fell = await new Promise((resolve) => {
    const req = { url: '/api/history/track?window=3600s', method: 'GET', headers: {} }
    const res = { statusCode: 200, headers: {}, chunks: '', on () {}, setHeader (k, v) { this.headers[k] = v }, writableFinished: false, end (b) { this.chunks = b || ''; this.writableFinished = true; resolve(this) } }
    proxy2._serveMirror(req, res)
  })
  assert.strictEqual(JSON.parse(fell.chunks).from, 'CLOUD-MIRROR', 'unconfigured history falls through to mirror')

  proxy.stop(); proxy2.stop(); influx.close(); upstream.close()
})
