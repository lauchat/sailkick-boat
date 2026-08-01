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
