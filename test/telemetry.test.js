'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')

const { createTelemetry } = require('../lib/telemetry')

const delta = (values, ts) => ({ context: 'vessels.self', updates: [{ $source: 'test', timestamp: ts || new Date().toISOString(), values }] })

test('accumulates SignalK deltas into BoatState (SI->kt/deg, resolved heading, gate on fix)', () => {
  const t = createTelemetry({ debug () {} }, {})
  t._ingest(delta([{ path: 'navigation.speedOverGround', value: 5 }]))
  assert.strictEqual(t._state(), null, 'no state emitted before the first position fix')

  t._ingest(delta([
    { path: 'navigation.position', value: { latitude: 36.95, longitude: -76.19 } },
    { path: 'navigation.speedOverGround', value: 5 }, // 5 m/s -> ~9.72 kt
    { path: 'navigation.headingMagnetic', value: Math.PI / 2 }, // 90° mag
    { path: 'navigation.magneticVariation', value: -0.1 } // ~ -5.73°
  ]))
  const s = t._state()
  assert.ok(s, 'state exists after fix')
  assert.ok(Math.abs(s.lat - 36.95) < 1e-9 && Math.abs(s.lon + 76.19) < 1e-9)
  assert.ok(Math.abs(s.sogKt - 5 * 1.94384) < 1e-3, 'm/s -> knots')
  assert.ok(Math.abs(s.headingDeg - (90 - 5.729578)) < 0.02, 'headingDeg = mag + variation, resolved')
  assert.strictEqual(typeof s.updatedAt, 'string')
})

// minimal WebSocket client over a raw socket: handshake, then read text frames
function wsConnect (port, path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: sailkick.telemetry.v1\r\n\r\n`)
    })
    let buf = Buffer.alloc(0); let handshaked = false
    const queue = []; const waiters = []
    const deliver = (m) => { const w = waiters.shift(); if (w) w(m); else queue.push(m) }
    const pump = () => {
      while (buf.length >= 2 && (buf[0] & 0x0f) === 0x1) {
        let len = buf[1] & 0x7f; let off = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
        if (buf.length < off + len) return
        const payload = buf.slice(off, off + len).toString(); buf = buf.slice(off + len)
        deliver(JSON.parse(payload))
      }
    }
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (!handshaked) {
        const idx = buf.indexOf('\r\n\r\n'); if (idx < 0) return
        const headers = buf.slice(0, idx).toString(); handshaked = true; buf = buf.slice(idx + 4)
        resolve({ socket: s, headers, next: () => new Promise((res) => { if (queue.length) res(queue.shift()); else waiters.push(res) }) })
      }
      pump()
    })
    s.on('error', reject)
    setTimeout(() => reject(new Error('ws timeout')), 3000)
  })
}

test('/ws/telemetry: 101 handshake + subprotocol, hello, then telemetry/update', async () => {
  const t = createTelemetry({ debug () {} }, {})
  const srv = http.createServer((req, res) => res.end('no'))
  srv.on('upgrade', (req, sock, head) => t.handleUpgrade(req, sock, head))
  await new Promise((r) => srv.listen(0, r))
  const port = srv.address().port

  const c = await wsConnect(port, '/ws/telemetry')
  assert.match(c.headers, /101 Switching Protocols/)
  assert.match(c.headers, /Sec-WebSocket-Accept:/)
  assert.match(c.headers, /Sec-WebSocket-Protocol: sailkick\.telemetry\.v1/)

  const hello = await c.next()
  assert.strictEqual(hello.type, 'hello')

  t._ingest(delta([
    { path: 'navigation.position', value: { latitude: 10, longitude: 20 } },
    { path: 'navigation.speedOverGround', value: 3 }
  ]))
  const upd = await c.next()
  assert.strictEqual(upd.type, 'telemetry/update')
  assert.ok(Math.abs(upd.state.lat - 10) < 1e-9 && Math.abs(upd.state.lon - 20) < 1e-9)
  assert.ok(upd.state.sogKt > 0)

  c.socket.destroy(); t.stop()
  if (srv.closeAllConnections) srv.closeAllConnections()
  srv.close()
})

// --- contract seam: our signalk-map must match the app's (v0.14.6) -----------------
// signalk-map.js is a verbatim copy of the app's public/engine/signalk-map.js
// (sailkick-archi 02-contracts.md calls it the highest-risk seam in the system). It had
// drifted: nine cases the app gained with "STW/attitude/autopilot telemetry" were never
// ported, so the boat silently dropped instrument true wind, STW, heel, rate of turn,
// rudder and autopilot state — data that was sitting on the SignalK bus.
const { signalkValuesToPatch } = require('../lib/telemetry/signalk-map')

test('maps STW, measured true wind, attitude and autopilot (the drifted cases)', () => {
  const p = signalkValuesToPatch([
    { path: 'navigation.speedThroughWater', value: 3.0866 }, // 6 kt
    { path: 'environment.wind.speedTrue', value: 6.1728 }, // 12 kt
    { path: 'environment.wind.directionTrue', value: Math.PI }, // 180°
    { path: 'steering.rudderAngle', value: Math.PI / 36 }, // 5°
    { path: 'navigation.rateOfTurn', value: Math.PI / 180 }, // 60 °/min
    { path: 'navigation.attitude', value: { roll: Math.PI / 18, pitch: 0, yaw: 0 } }, // 10° heel
    { path: 'steering.autopilot.state', value: 'heading' },
    { path: 'steering.autopilot.target.headingTrue', value: Math.PI / 2 }, // 90°
    { path: 'steering.autopilot.target.windAngleApparent', value: -Math.PI / 4 } // -45°
  ])
  assert.ok(Math.abs(p.stwKt - 6) < 0.01)
  assert.ok(Math.abs(p.twsKt - 12) < 0.01)
  assert.ok(Math.abs(p.twdDeg - 180) < 0.01)
  assert.ok(Math.abs(p.rudderDeg - 5) < 0.01)
  assert.ok(Math.abs(p.rotDegMin - 60) < 0.01)
  assert.ok(Math.abs(p.heelDeg - 10) < 0.01)
  assert.strictEqual(p.apState, 'heading')
  assert.ok(Math.abs(p.apTargetDeg - 90) < 0.01)
  assert.ok(Math.abs(p.apTargetAwa + 45) < 0.01)
})

// --- second drift, found v0.18.6 ---------------------------------------------------
// Active-waypoint course data plus TWA/VMG/temperatures/engine rpm. This is why routes
// and waypoint readouts were blank when the app was served from the boat but fine
// against the cloud: the deltas arrive (telemetry subscribes to '*') and were dropped
// on the floor by the mapper.
test('maps active-waypoint course data under all three SignalK publish prefixes', () => {
  for (const prefix of ['navigation.courseGreatCircle.nextPoint', 'navigation.courseRhumbline.nextPoint', 'navigation.course.calcValues']) {
    const p = signalkValuesToPatch([
      { path: `${prefix}.bearingTrue`, value: Math.PI }, // 180°
      { path: `${prefix}.distance`, value: 1852 }, // 1 nm
      { path: `${prefix}.velocityMadeGood`, value: 2.5722 }, // 5 kt
      { path: `${prefix}.timeToGo`, value: 720 }
    ])
    assert.ok(Math.abs(p.wptBrgDeg - 180) < 0.01, prefix + ' bearing')
    assert.ok(Math.abs(p.wptDistNm - 1) < 0.001, prefix + ' distance')
    assert.ok(Math.abs(p.wptVmgKt - 5) < 0.01, prefix + ' vmg')
    assert.strictEqual(p.wptTtgSec, 720, prefix + ' ttg')
  }
})

test('a cleared destination clears the waypoint values instead of leaving them stale', () => {
  // Unlike a sensor, a null here MEANS something. If it were skipped like a missing
  // sensor reading the ribbon would show the old waypoint numbers forever.
  const p = signalkValuesToPatch([
    { path: 'navigation.courseGreatCircle.nextPoint.bearingTrue', value: null },
    { path: 'navigation.courseGreatCircle.nextPoint.distance', value: null },
    { path: 'navigation.courseGreatCircle.nextPoint.velocityMadeGood', value: null },
    { path: 'navigation.courseGreatCircle.nextPoint.timeToGo', value: null }
  ])
  assert.deepStrictEqual(p, { wptBrgDeg: null, wptDistNm: null, wptVmgKt: null, wptTtgSec: null })
  // and a negative time-to-go is not a time
  assert.strictEqual(signalkValuesToPatch([{ path: 'navigation.course.calcValues.timeToGo', value: -5 }]).wptTtgSec, null)
})

test('the null clear survives the state merge and reaches the wire', () => {
  const t = createTelemetry({ debug () {} }, {})
  t._ingest(delta([
    { path: 'navigation.position', value: { latitude: 43.29, longitude: 5.36 } },
    { path: 'navigation.courseGreatCircle.nextPoint.distance', value: 3704 }
  ]))
  assert.ok(Math.abs(t._state().wptDistNm - 2) < 0.001)
  t._ingest(delta([{ path: 'navigation.courseGreatCircle.nextPoint.distance', value: null }]))
  assert.strictEqual(t._state().wptDistNm, null, 'cleared, not stale')
  assert.ok(JSON.stringify(t._state()).includes('"wptDistNm":null'), 'null survives serialisation')
})

test('maps true wind angle, VMG, sea/air temperature and engine revolutions', () => {
  const p = signalkValuesToPatch([
    { path: 'environment.wind.angleTrueWater', value: -Math.PI / 4 }, // -45°
    { path: 'performance.velocityMadeGood', value: -1.0289 }, // -2 kt (losing ground)
    { path: 'environment.water.temperature', value: 291.15 }, // 18 °C
    { path: 'environment.outside.temperature', value: 298.15 }, // 25 °C
    { path: 'propulsion.port.revolutions', value: 30 }, // 1800 rpm
    { path: 'propulsion.starboard.revolutions', value: 25 } // 1500 rpm
  ])
  assert.ok(Math.abs(p.twaDeg + 45) < 0.01)
  assert.ok(Math.abs(p.vmgKt + 2) < 0.01, 'VMG keeps its sign')
  assert.ok(Math.abs(p.seaTempC - 18) < 0.01)
  assert.ok(Math.abs(p.airTempC - 25) < 0.01)
  assert.ok(Math.abs(p.rpmPort - 1800) < 0.01)
  assert.ok(Math.abs(p.rpmStbd - 1500) < 0.01)
})

// --- the guard that should have caught both drifts ---------------------------------
// Structural parity against the app's own source, when both repos are checked out.
// It compares the SET of BoatState fields each copy can produce — which is what the
// app actually consumes — rather than the text, since ours is CommonJS and theirs is
// an ES module. Skipped (not failed) when the app source isn't present, so npm-only
// checkouts still pass.
const fs = require('node:fs')
const APP_MAP = process.env.SAILKICK_APP_REPO
  ? `${process.env.SAILKICK_APP_REPO}/public/engine/signalk-map.js`
  : '/workspace/sailkick/public/engine/signalk-map.js'

test('contract seam: our mapper produces every BoatState field the app\'s does', { skip: !fs.existsSync(APP_MAP) && 'app source not checked out' }, () => {
  const fields = (src) => new Set([...src.matchAll(/patch\.([A-Za-z]+)\s*=/g)].map((m) => m[1]))
  const theirs = fields(fs.readFileSync(APP_MAP, 'utf8'))
  const ours = fields(fs.readFileSync(require.resolve('../lib/telemetry/signalk-map'), 'utf8'))
  const missing = [...theirs].filter((f) => !ours.has(f)).sort()
  assert.deepStrictEqual(missing, [], 'fields the app sets and we never emit — re-port lib/telemetry/signalk-map.js')
})

test('contract seam: the pinned app hash matches the app source we ported from', { skip: !fs.existsSync(APP_MAP) && 'app source not checked out' }, () => {
  const { PINNED_APP_HASH } = require('../lib/telemetry/contract')
  const actual = crypto.createHash('sha256').update(fs.readFileSync(APP_MAP)).digest('hex').slice(0, 12)
  assert.strictEqual(actual, PINNED_APP_HASH,
    'the app\'s signalk-map.js changed since we ported it — re-port, then update PINNED_APP_HASH in lib/telemetry/contract.js')
})

// --- runtime drift detection --------------------------------------------------------
const { createContractCheck } = require('../lib/telemetry/contract')

test('contract check: reports drift, silence when in sync, unknown on old servers', async () => {
  const warnings = []
  const stub = { debug () {}, error (m) { warnings.push(m) } }
  const serve = (body) => http.createServer((req, res) => {
    if (req.url !== '/health') { res.statusCode = 404; res.end(); return }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body))
  })

  const { PINNED_APP_HASH } = require('../lib/telemetry/contract')
  const cases = [
    [{ ok: true, contracts: { signalkMap: 'deadbeefcafe' } }, true, 1],
    [{ ok: true, contracts: { signalkMap: PINNED_APP_HASH } }, false, 0],
    [{ ok: true }, null, 0] // a server predating the contract hash → unknown, not a warning
  ]
  for (const [body, expected, warns] of cases) {
    warnings.length = 0
    const srv = serve(body)
    await new Promise((r) => srv.listen(0, r))
    const c = createContractCheck(stub, {})
    assert.strictEqual(await c.check(`http://127.0.0.1:${srv.address().port}`), expected)
    assert.strictEqual(warnings.length, warns, JSON.stringify(body))
    if (expected) assert.match(c.status(), /DRIFTED/)
    else assert.strictEqual(c.status(), null, 'no status noise unless drifted')
    await new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r) })
  }
})

test('contract check: offline is not drift, and a drift is logged once, not every poll', async () => {
  const warnings = []
  const stub = { debug () {}, error (m) { warnings.push(m) } }
  const c = createContractCheck(stub, { timeoutMs: 500 })
  assert.strictEqual(await c.check('http://127.0.0.1:1'), null, 'unreachable → unknown')
  assert.strictEqual(warnings.length, 0, 'being offline is the normal case, not a warning')

  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"contracts":{"signalkMap":"0000deadbeef"}}') })
  await new Promise((r) => srv.listen(0, r))
  const up = `http://127.0.0.1:${srv.address().port}`
  await c.check(up); await c.check(up); await c.check(up)
  assert.strictEqual(warnings.length, 1, 'warned once, not once per 5-minute poll')
  await new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r) })
})

// --- source arbitration belongs to Signal K (v0.22.3) -------------------------------
// This module used to lock onto the first $source seen for navigation.headingMagnetic
// and ignore the rest. Measured on the boat, that guard was a coin flip between a
// Precision-9 and a ZG100 reading 7.5° apart — and once sourcePriorities was configured
// it became actively harmful, because Signal K REPLAYS current values when a client
// subscribes. The first headingMagnetic delta after a restart can therefore be a one-off
// from a de-prioritised device, and latching onto it discarded every real delta that
// followed: heading frozen at a stale value rather than merely wrong.
const withSrc = (src, values) => ({
  context: 'vessels.self',
  updates: [{ $source: src, timestamp: new Date().toISOString(), values }]
})

test('telemetry: a one-off replay from another source cannot freeze heading', () => {
  const t = createTelemetry({ debug () {} }, {})
  t._ingest(withSrc('NMEA.128', [{ path: 'navigation.position', value: { latitude: 43.9, longitude: -64.8 } }]))

  // Exactly the boat's shape: ONE stale delta from the de-prioritised compass at
  // subscribe time, then a steady stream from the real one.
  t._ingest(withSrc('NMEA.128', [{ path: 'navigation.headingMagnetic', value: 1.9092 }])) // ZG100, 109.4°
  for (let i = 0; i < 5; i++) {
    t._ingest(withSrc('NMEA.23', [{ path: 'navigation.headingMagnetic', value: 2.0369 }])) // Precision-9, 116.7°
  }
  const s = t._state()
  assert.ok(Math.abs(s.hdgMagDeg - 116.71) < 0.05,
    `heading must follow the live source, got ${s.hdgMagDeg} — the old guard froze it at the replay`)
})

test('telemetry: whatever Signal K delivers is used, whichever source it carries', () => {
  // With sourcePriorities set, only one source reaches us per path; the plugin must not
  // second-guess that. A source CHANGE is legitimate — a failover after the preferred
  // device goes quiet — and must be followed, not ignored.
  const t = createTelemetry({ debug () {} }, {})
  t._ingest(withSrc('NMEA.23', [
    { path: 'navigation.position', value: { latitude: 1, longitude: 2 } },
    { path: 'navigation.headingMagnetic', value: 1.0 }
  ]))
  assert.ok(Math.abs(t._state().hdgMagDeg - 57.3) < 0.1, 'first source used')

  t._ingest(withSrc('NMEA.128', [{ path: 'navigation.headingMagnetic', value: 2.0 }]))
  assert.ok(Math.abs(t._state().hdgMagDeg - 114.6) < 0.1, 'a failover to another source is followed')
})
