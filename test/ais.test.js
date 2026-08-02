'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { createAis, isInternetFeed } = require('../lib/ais')

const SELF = 'vessels.urn:mrn:signalk:uuid:1111-self'
const OTHER = 'vessels.urn:mrn:imo:mmsi:368315820'

let seq = 0
function tmpApp () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sk-ais-${process.pid}-${seq++}-`))
  const errors = []
  return {
    dir,
    errors,
    app: {
      debug () {},
      error (m) { errors.push(m) },
      getDataDirPath: () => dir,
      selfContext: SELF,
      subscriptionmanager: { subscribe () {} }
    }
  }
}

const delta = (context, source, values, ts) => ({
  context,
  updates: [{ $source: source, timestamp: ts || new Date().toISOString(), values }]
})
const POS = [
  { path: 'navigation.position', value: { latitude: 41.58, longitude: -71.4 } },
  { path: 'navigation.speedOverGround', value: 5 },
  { path: 'navigation.courseOverGroundTrue', value: 1.2 }
]
const STATIC = [
  { path: 'design.length', value: { overall: 27 } },
  { path: 'design.beam', value: 5 },
  { path: 'design.aisShipType', value: { id: 49, name: 'High speed craft' } }
]

// Start a module with the uploader inert (no destination reachable) so we can inspect
// exactly what the delta handler produced.
function startAis (extra = {}) {
  const { app, dir, errors } = tmpApp()
  const a = createAis(app, {
    influxUrl: 'http://127.0.0.1:1',
    org: 'sailkick',
    bucket: 'addiction_raw',
    token: 'W',
    flushIntervalMs: 100000, // never auto-flush; tests inspect the batch directly
    idlePollMs: 100000,
    ...extra
  })
  a.start()
  return { a, dir, errors }
}

test('never forwards our own vessel', () => {
  const { a } = startAis()
  a._handleDelta(delta(SELF, 'n2k.gps', POS))
  assert.strictEqual(a._state().batch.length, 0, 'self deltas are not AIS')
  a._handleDelta(delta(OTHER, 'n2k.ais', POS))
  assert.ok(a._state().batch.length > 0, 'another vessel is')
  a.stop()
})

test('every AIS row is tagged self=false', () => {
  // This tag is the entire contract with the cloud: its history queries filter on
  // self=="true", so a wrong tag here puts other ships into the owner's SOG chart.
  const { a } = startAis()
  a._handleDelta(delta(OTHER, 'n2k.ais', POS))
  const lines = a._state().batch
  assert.ok(lines.length > 0)
  for (const l of lines) {
    assert.match(l, /,self=false,/, `must be self=false: ${l}`)
    assert.match(l, /context=vessels\.urn:mrn:imo:mmsi:368315820/, 'context identifies the vessel')
  }
  a.stop()
})

test('internet feeds are skipped; a local receiver is forwarded', () => {
  const { a } = startAis()
  a._handleDelta(delta(OTHER, 'signalk-aisstream', POS))
  assert.strictEqual(a._state().batch.length, 0, 'aisstream is an internet feed — the cloud can fetch it itself')
  assert.ok(a._state().dropped > 0, 'and it is counted, not silently ignored')

  a._handleDelta(delta(OTHER, 'n2k.ais.0', POS))
  assert.ok(a._state().batch.length > 0, 'the boat\'s own receiver is forwarded')
  a.stop()
})

test('isInternetFeed matches the known aggregators, not a local N2K source', () => {
  for (const s of ['signalk-aisstream', 'AISStream', 'aishub-client', 'marinetraffic']) {
    assert.strictEqual(isInternetFeed(s), true, s)
  }
  for (const s of ['n2k.ais.0', 'NMEA0183.AI', 'canbus0', undefined]) {
    assert.strictEqual(isInternetFeed(s), false, String(s))
  }
})

test('an explicit source forwards only that one', () => {
  const { a } = startAis({ source: 'n2k.ais.0' })
  a._handleDelta(delta(OTHER, 'n2k.ais.9', POS))
  assert.strictEqual(a._state().batch.length, 0, 'a different local source is still excluded')
  a._handleDelta(delta(OTHER, 'n2k.ais.0', POS))
  assert.ok(a._state().batch.length > 0)
  a.stop()
})

test('identity is re-sent at most hourly; positions are never throttled', () => {
  const { a } = startAis({ staticIntervalMs: 3600000 })
  a._handleDelta(delta(OTHER, 'n2k.ais', [...POS, ...STATIC]))
  const first = a._state().batch.length
  assert.ok(first >= 6, 'first report carries position and identity')
  assert.ok(a._state().batch.some((l) => l.startsWith('design.beam')), 'identity present')

  a._state().batch.length = 0
  // ShipStaticData repeats every ~6 min per vessel and never changes.
  a._handleDelta(delta(OTHER, 'n2k.ais', [...POS, ...STATIC]))
  const second = a._state().batch
  assert.ok(!second.some((l) => l.startsWith('design.')), 'identity is not re-sent')
  assert.ok(second.some((l) => l.startsWith('navigation.position')), 'position always is')

  // A different vessel gets its own hourly budget.
  a._state().batch.length = 0
  a._handleDelta(delta('vessels.urn:mrn:imo:mmsi:999', 'n2k.ais', [...POS, ...STATIC]))
  assert.ok(a._state().batch.some((l) => l.startsWith('design.beam')), 'per-vessel, not global')
  a.stop()
})

test('only the paths the cloud AIS view needs are forwarded', () => {
  const { a } = startAis()
  a._handleDelta(delta(OTHER, 'n2k.ais', [
    ...POS,
    { path: 'navigation.datetime', value: '2026-08-02T10:00:00Z' },
    { path: 'sensors.ais.class', value: 'A' }
  ]))
  const measurements = a._state().batch.map((l) => l.split(',')[0])
  assert.ok(measurements.includes('navigation.position'))
  assert.ok(!measurements.includes('navigation.datetime'), 'point timestamps already carry this')
  assert.ok(!measurements.includes('sensors.ais.class'), 'not in the /api/ais envelope')
  a.stop()
})

test('uses its own spool, so an AIS flood cannot evict unsent telemetry', () => {
  const { a, dir } = startAis()
  a._handleDelta(delta(OTHER, 'n2k.ais', POS))
  a._flush()
  return new Promise((resolve) => setTimeout(() => {
    assert.ok(fs.existsSync(path.join(dir, 'ais-spool')), 'AIS buffers separately')
    assert.ok(!fs.existsSync(path.join(dir, 'spool')), 'the telemetry spool is untouched')
    a.stop(); resolve()
  }, 120))
})

test('stands down while the telemetry spool has a backlog', async () => {
  let depth = 4
  let writes = 0
  const srv = http.createServer((req, res) => { writes++; res.statusCode = 204; res.end() })
  await new Promise((r) => srv.listen(0, r))
  const { app } = tmpApp()
  const a = createAis(app, {
    influxUrl: `http://127.0.0.1:${srv.address().port}`,
    org: 'sailkick',
    bucket: 'addiction_raw',
    token: 'W',
    flushIntervalMs: 20,
    idlePollMs: 20,
    pending: async () => ({ count: depth, bytes: depth * 100 })
  })
  a.start()
  a._handleDelta(delta(OTHER, 'n2k.ais', POS))
  await new Promise((r) => setTimeout(r, 200))
  assert.strictEqual(writes, 0, 'nothing uploaded while telemetry is behind')
  assert.match(a.status(), /telemetry backlog/)

  depth = 0 // telemetry catches up
  await new Promise((r) => setTimeout(r, 400))
  assert.ok(writes > 0, 'AIS resumes once the link is free')
  a.stop()
  try { srv.closeAllConnections() } catch {}
  srv.close()
})

test('not started without a paired account', () => {
  const { app, errors } = tmpApp()
  const a = createAis(app, { influxUrl: 'http://x', org: 'o', bucket: '', token: '' })
  a.start()
  assert.match(a.status(), /not configured/)
  assert.ok(errors.some((e) => /not paired/.test(e)))
})
