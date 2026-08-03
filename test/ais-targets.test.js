'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const { createAisTargets, restOrigin } = require('../lib/ais/targets')
const { createProxy } = require('../lib/proxy')

const app = { debug () {} }
const SELF_MMSI = '269118770'

// A stand-in SignalK REST tree, shaped exactly as the real one: `name` is a bare string
// (not the usual {value} wrapper), position carries its own AIS timestamp beside .value,
// and aisShipType is an {id,name} object.
function fakeSignalk (vessels, { selfUrn = `vessels.urn:mrn:imo:mmsi:${SELF_MMSI}` } = {}) {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/signalk/v1/api/self')) return res.end(JSON.stringify(selfUrn))
    if (req.url.startsWith('/signalk/v1/api/vessels')) return res.end(JSON.stringify(vessels))
    res.statusCode = 404; res.end('{}')
  })
}

const target = (lat, lon, extra = {}) => ({
  name: 'WINDSERVE GENESIS',
  navigation: {
    position: { value: { latitude: lat, longitude: lon }, timestamp: '2026-08-02T10:00:00Z' },
    speedOverGround: { value: 3.0866 }, // 6 kt
    courseOverGroundTrue: { value: Math.PI / 2 }, // 90°
    headingTrue: { value: Math.PI }, // 180°
    rateOfTurn: { value: 0.01 },
    ...extra
  },
  design: { length: { value: { overall: 27 } }, beam: { value: 5 }, aisShipType: { value: { id: 49, name: 'High speed craft' } } }
})

const listen = (srv) => new Promise((r) => srv.listen(0, r))
const shut = (srv) => { try { srv.closeAllConnections() } catch {} try { srv.close() } catch {} }
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms))

test('restOrigin normalises ws/wss and a /signalk path to the REST origin', () => {
  assert.strictEqual(restOrigin('ws://boat:3000/signalk/v1/stream'), 'http://boat:3000')
  assert.strictEqual(restOrigin('wss://boat/signalk/v1/stream?subscribe=self'), 'https://boat')
  assert.strictEqual(restOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000')
})

test('builds the /api/ais envelope the app expects, in display units', async () => {
  const srv = fakeSignalk({
    [`vessels.urn:mrn:imo:mmsi:${SELF_MMSI}`]: target(1, 1), // our own boat
    'vessels.urn:mrn:imo:mmsi:368315820': target(41.588, -71.409)
  })
  await listen(srv)
  const t = createAisTargets(app, { localSignalkUrl: `http://127.0.0.1:${srv.address().port}` })
  t.start(); await settle(200)

  const { vessels, count } = t.getVessels()
  assert.strictEqual(count, 1, 'our own vessel is excluded')
  const v = vessels[0]
  assert.strictEqual(v.mmsi, '368315820')
  assert.strictEqual(v.name, 'WINDSERVE GENESIS', 'name is a bare string in SignalK, not {value}')
  assert.ok(Math.abs(v.sogKt - 6) < 0.05, 'm/s converted to knots')
  assert.ok(Math.abs(v.cogDeg - 90) < 0.01, 'radians converted to degrees')
  assert.ok(Math.abs(v.headingDeg - 180) < 0.01)
  assert.strictEqual(v.loaM, 27)
  assert.strictEqual(v.beamM, 5)
  assert.strictEqual(v.shipType, 'High speed craft')
  assert.strictEqual(v.aisType, 49)
  assert.strictEqual(v.posTs, Date.parse('2026-08-02T10:00:00Z'), 'the AIS report time, not the poll time')
  assert.ok(Array.isArray(v.trail) && v.trail.length === 1)
  t.stop(); shut(srv)
})

test('heading falls back to magnetic + variation when true heading is absent', async () => {
  const srv = fakeSignalk({
    'vessels.urn:mrn:imo:mmsi:1': target(1, 1, { headingTrue: undefined, headingMagnetic: { value: 0 }, magneticVariation: { value: Math.PI / 18 } })
  })
  await listen(srv)
  const t = createAisTargets(app, { localSignalkUrl: `http://127.0.0.1:${srv.address().port}` })
  t.start(); await settle(200)
  assert.ok(Math.abs(t.getVessels().vessels[0].headingDeg - 10) < 0.01, 'magnetic + variation')
  t.stop(); shut(srv)
})

test('the trail only grows once a vessel has actually moved', async () => {
  // Anchored ships jitter by metres; without a movement threshold each poll would add a
  // point and the chart would show a cloud instead of a dot.
  const t = createAisTargets(app, { localSignalkUrl: 'http://127.0.0.1:1', trailMinMoveM: 30 })
  const at = (lat, lon) => ({ 'vessels.urn:mrn:imo:mmsi:1': target(lat, lon) })
  t._ingest(at(43.0000, 5.0000))
  t._ingest(at(43.00005, 5.00005)) // ~7 m — jitter
  assert.strictEqual(t._state().get('1').trail.length, 1, 'jitter adds no trail point')
  t._ingest(at(43.0100, 5.0000)) // ~1.1 km — real movement
  assert.strictEqual(t._state().get('1').trail.length, 2)
  t.stop()
})

test('a vessel not heard from is dropped', async () => {
  const t = createAisTargets(app, { localSignalkUrl: 'http://127.0.0.1:1', staleMs: 1 })
  t._ingest({ 'vessels.urn:mrn:imo:mmsi:1': target(1, 1) })
  assert.strictEqual(t.getVessels().count, 1)
  await settle(20)
  assert.strictEqual(t.getVessels().count, 0, 'stale targets disappear')
  t.stop()
})

test('a failed poll keeps the last snapshot instead of blanking the chart', async () => {
  const srv = fakeSignalk({ 'vessels.urn:mrn:imo:mmsi:1': target(1, 1) })
  await listen(srv)
  const t = createAisTargets(app, { localSignalkUrl: `http://127.0.0.1:${srv.address().port}`, pollMs: 40 })
  t.start(); await settle(150)
  assert.strictEqual(t.getVessels().count, 1)
  shut(srv) // SignalK goes away mid-passage
  await settle(200)
  assert.strictEqual(t.getVessels().count, 1, 'targets survive a failed poll')
  assert.ok(t.getVessels().error, 'but the error is reported')
  t.stop()
})

test('the mirror serves /api/ais locally instead of proxying the cloud 401', async () => {
  // The cloud gates /api/ais behind a boat session the mirror cannot hold, and its
  // poller reads a LAN address it cannot reach — so proxying it can only ever fail.
  const cloud = http.createServer((req, res) => {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: false, code: 'auth-required' }))
  })
  await listen(cloud)
  const sk = fakeSignalk({ 'vessels.urn:mrn:imo:mmsi:368315820': target(41.5, -71.4) })
  await listen(sk)

  const targets = createAisTargets(app, { localSignalkUrl: `http://127.0.0.1:${sk.address().port}` })
  targets.start(); await settle(200)

  const proxy = createProxy(app, {
    sailkickUrl: `http://127.0.0.1:${cloud.address().port}`,
    proxyPort: 0,
    aisTargets: targets,
    storeDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'sk-aist-')),
    manifest: { enabled: false },
    seed: { enabled: false }
  })
  proxy.start()

  const res = await new Promise((resolve) => {
    const r = { statusCode: 200, headers: {}, body: '', on () {}, setHeader (k, v) { this.headers[k] = v }, writableFinished: false, end (b) { this.body = b || ''; this.writableFinished = true; resolve(this) } }
    proxy._serveMirror({ url: '/api/ais', method: 'GET', headers: {} }, r)
  })
  assert.strictEqual(res.statusCode, 200, 'not the cloud 401')
  const j = JSON.parse(res.body)
  assert.strictEqual(j.available, true)
  assert.strictEqual(j.count, 1)
  assert.strictEqual(j.vessels[0].mmsi, '368315820')

  targets.stop(); proxy.stop(); shut(cloud); shut(sk)
})
