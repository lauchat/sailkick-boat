'use strict'

const crypto = require('crypto')
const { signalkValuesToPatch, resolveHeadingDeg } = require('./signalk-map')

// Choosing between competing sources is SIGNAL K'S JOB, not this module's. A boat
// commonly has several devices publishing the same path — this one carries two compasses
// 7.5 deg apart on navigation.headingMagnetic, and three log sources on
// speedThroughWater, one of which reports a constant 0. Signal K resolves that from
// `sourcePriorities` in settings.json, applied in its delta pipeline (deltaPriority.js,
// called at index.js:268) BEFORE anything downstream sees the delta. So by the time a
// value reaches here it has already been arbitrated, and every consumer on the boat —
// this plugin, KIP, the instruments — agrees.
//
// This module used to keep its own guard for navigation.headingMagnetic: lock onto the
// first $source seen and ignore the rest. That was a coin flip (it could equally lock
// onto the WRONG compass and be quietly 7.5 deg out for the whole session), and once
// priorities were configured it became actively harmful: Signal K replays current values
// when a client subscribes, so the first headingMagnetic delta after a restart can be a
// one-off from a de-prioritised device. Latching onto that would have discarded every
// real heading delta thereafter — heading frozen at a stale value rather than merely
// wrong. Removed in v0.22.3; set `sourcePriorities` instead.
//
// Serves the sailkick app's /ws/telemetry bus FROM the boat's local SignalK, so
// the app uses the identical telemetry contract whether it talks to the cloud
// sailkick server or this on-boat plugin. Faithful port of the server's
// SignalKSource (SEED, gate-on-first-fix, accumulate, resolve headingDeg,
// updatedAt) + bus wire format ({type:'hello'|'telemetry/update', state}).
// Dependency-free WebSocket server (handshake + text frames).

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const SUBPROTOCOL = 'sailkick.telemetry.v1'
const wrap360d = (d) => ((d % 360) + 360) % 360
const wrap180 = (d) => { const w = wrap360d(d); return w > 180 ? w - 360 : w }
const SEED = { sogKt: 0, cogDeg: 0, headingDeg: 0, awsKt: null, awaDeg: null }

function encodeTextFrame (str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) } else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([header, payload])
}

// Signal K publishes active-waypoint course data under THREE prefixes, and
// signalk-map.js maps all of them onto the same BoatState fields (wptDistNm and friends)
// — see COURSE_RE there. On a boat that publishes more than one, whichever delta arrives
// last wins and the readout flip-flops: measured here, courseGreatCircle said 2049.48 nm
// while course.calcValues said 2050.86 nm, alternating several times a second.
//
// Signal K's own sourcePriorities cannot fix this. It arbitrates between SOURCES on ONE
// path; here the competing values are on DIFFERENT paths, each legitimately sourced.
//
// The app already states the intended order on its history side: great circle is primary,
// the other two are `fallback: true` (server/history/influx-provider.js). Its LIVE mapper
// simply never implemented that, which does not show up in the cloud because that
// deployment reads history rather than live Signal K. So this applies the app's own
// documented precedence to the live stream.
//
// Deliberately NOT patched into lib/telemetry/signalk-map.js: that file is vendored
// verbatim from the app and must stay byte-comparable. Handed upstream so the rule can
// move into COURSE_RE and this can be deleted.
// The boat's PUBLISHED navigation.headingTrue is preferred over deriving true heading
// from magnetic + variation.
//
// The vendored mapper's resolveHeadingDeg() does the opposite. The case it cites — a
// heading frozen at 151° while the compass read true ~293° — came from ANOTHER vessel's
// AIS data, not from self telemetry, so it is weak evidence for distrusting a boat's own
// instruments. This boat's headingTrue is healthy and agrees to 0.52°.
//
// A cross-check is still worth having against a genuinely broken publisher, but ONLY when
// there is something valid to check against. resolveHeadingDeg() returns RAW MAGNETIC
// when no variation is published, and comparing a true heading against raw magnetic just
// measures the variation — 16° here, more elsewhere. A guard built on that would reject a
// perfectly good headingTrue on every boat that does not publish variation, and report
// magnetic as if it were true: a 16° error introduced by the safety check itself. So the
// comparison runs only when variation is on the bus, and both sides are true headings.
// Both sides are TRUE headings, so a healthy boat sits near zero (0.52° here). This is
// sized to catch a stuck publisher, not to police variation error.
const HEADING_DISAGREE_DEG = 10

// Each group is one BoatState field fed by several paths, most-preferred first.
const PRECEDENCE_GROUPS = [
  // Active waypoint: wptBrgDeg / wptDistNm / wptVmgKt / wptTtgSec (COURSE_RE).
  ['navigation.courseGreatCircle.nextPoint.',
    'navigation.courseRhumbline.nextPoint.',
    'navigation.course.calcValues.'],
  // depthM. Both are published by the same transducer here, 0.3 m apart — that gap IS
  // environment.depth.surfaceToTransducer. belowSurface is the honest "how much water is
  // under me" number and is what signalk-map.js calls preferred, so it wins.
  //
  // NOTE for the re-vendor: the app's two implementations disagree here. Its live mapper
  // comments belowSurface "preferred" and belowTransducer "fallback", while its history
  // provider (influx-provider.js MAP) has belowTransducer primary and belowSurface
  // `fallback: true` — the opposite. So live and Trends can differ by the transducer
  // offset for the same instant. Flagged upstream; this follows the live mapper.
  ['environment.depth.belowSurface', 'environment.depth.belowTransducer']
]
// How long a higher-priority path stays "live" after its last value. Long enough to
// cover a slow publisher, short enough that a genuinely stopped source hands over.
const PRECEDENCE_STALE_MS = 10000

function createTelemetry (app, options = {}) {
  const log = (m) => (app.debug ? app.debug('[telemetry] ' + m) : console.log('[sailkick-boat:telemetry]', m))
  let state = null
  const pathSeen = new Map() // 'group:index' -> last ms, for the precedence above
  const clients = new Set()
  const unsubscribes = []

  function send (socket, obj) {
    try { socket.write(encodeTextFrame(JSON.stringify(obj))) } catch { clients.delete(socket) }
  }
  function broadcast (obj) {
    const frame = encodeTextFrame(JSON.stringify(obj))
    for (const s of clients) { try { s.write(frame) } catch { clients.delete(s) } }
  }

  // Drop a value whose path is covered by a higher-priority sibling that is currently
  // publishing. Anything outside PRECEDENCE_GROUPS passes through untouched.
  function applyPrecedence (values) {
    const hit = (path) => {
      for (let g = 0; g < PRECEDENCE_GROUPS.length; g++) {
        const i = PRECEDENCE_GROUPS[g].findIndex((p) => path === p || path.startsWith(p))
        if (i >= 0) return { g, i }
      }
      return null
    }
    let touched = false
    for (const v of values) {
      if (!v || !v.path) continue
      const h = hit(v.path)
      if (h) { pathSeen.set(`${h.g}:${h.i}`, Date.now()); touched = true }
    }
    if (!touched) return values
    const now = Date.now()
    return values.filter((v) => {
      if (!v || !v.path) return true
      const h = hit(v.path)
      if (!h || h.i === 0) return true // not grouped, or already the top choice
      for (let j = 0; j < h.i; j++) {
        const seen = pathSeen.get(`${h.g}:${j}`)
        if (seen && now - seen < PRECEDENCE_STALE_MS) return false
      }
      return true
    })
  }

  // See HEADING_DISAGREE_DEG. Returns true heading in degrees, or undefined.
  let headingWarned = false
  function resolveHeading (st) {
    const derived = resolveHeadingDeg(st) // magnetic + variation, per the vendored mapper
    const published = st.hdgTrueDeg
    if (!Number.isFinite(published)) return derived
    if (!Number.isFinite(derived)) return published
    // Without variation, `derived` is raw MAGNETIC and the comparison would just measure
    // the variation. Nothing to corroborate against — take the boat at its word.
    if (!Number.isFinite(st.magVarDeg)) return published
    const gap = Math.abs(wrap180(published - derived))
    if (gap > HEADING_DISAGREE_DEG) {
      if (!headingWarned) {
        headingWarned = true
        const warn = app.error ? (m) => app.error('[sailkick-boat:telemetry] ' + m) : log
        warn(`navigation.headingTrue (${published.toFixed(1)}°) disagrees with the compass + variation ` +
          `(${derived.toFixed(1)}°) by ${gap.toFixed(1)}° — using the compass. A headingTrue that is ` +
          'stale or static is a known failure mode; check which device publishes it.')
      }
      return derived
    }
    if (headingWarned) { headingWarned = false; log('navigation.headingTrue agrees with the compass again — using it') }
    return published
  }

  function onDelta (delta) {
    if (!delta || !Array.isArray(delta.updates)) return
    const patch = {}
    let ts = null
    for (const u of delta.updates) {
      if (!u || !Array.isArray(u.values)) continue
      Object.assign(patch, signalkValuesToPatch(applyPrecedence(u.values)))
      if (u.timestamp) ts = u.timestamp
    }
    if (Object.keys(patch).length === 0) return
    if (!state) {
      if (!Number.isFinite(patch.lat) || !Number.isFinite(patch.lon)) return // wait for the first fix
      state = { ...SEED }
    }
    state = { ...state, ...patch, updatedAt: ts || new Date().toISOString() }
    const hd = resolveHeading(state)
    state.headingDeg = Number.isFinite(hd) ? hd : (state.headingDeg || state.cogDeg || 0)
    broadcast({ type: 'telemetry/update', state })
  }

  function start () {
    const sub = { context: 'vessels.self', subscribe: [{ path: '*', period: options.periodMs || 1000 }] }
    if (app.subscriptionmanager && app.subscriptionmanager.subscribe) {
      app.subscriptionmanager.subscribe(sub, unsubscribes, (err) => log('subscription error: ' + err), onDelta)
    } else if (app.signalk && app.signalk.on) {
      const selfCtx = app.selfContext || ('vessels.' + (app.selfId || 'self'))
      const h = (d) => { if (!d.context || d.context === selfCtx) onDelta(d) }
      app.signalk.on('delta', h)
      unsubscribes.push(() => app.signalk.removeListener('delta', h))
    } else {
      log('no subscription mechanism available — telemetry inactive')
    }
    log('/ws/telemetry provider started (from local SignalK self stream)')
  }

  function stop () {
    for (const u of unsubscribes) { try { u() } catch {} }
    unsubscribes.length = 0
    for (const s of clients) { try { s.destroy() } catch {} }
    clients.clear()
    state = null
  }

  function status () {
    return `telemetry: ${clients.size} client(s), ${state ? 'live' : 'waiting for fix'}`
  }

  // Handle a WebSocket upgrade for /ws/telemetry: handshake, add client, hello.
  function handleUpgrade (req, socket, head) {
    const key = req.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim())
    let resp = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n`
    if (offered.includes(SUBPROTOCOL)) resp += `Sec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n`
    resp += '\r\n'
    socket.write(resp)
    clients.add(socket)
    const drop = () => clients.delete(socket)
    socket.on('close', drop)
    socket.on('error', () => { drop(); try { socket.destroy() } catch {} })
    socket.on('data', (buf) => { if (buf && buf.length && (buf[0] & 0x0f) === 0x8) { drop(); try { socket.destroy() } catch {} } }) // client close frame
    send(socket, { type: 'hello', source: 'signalk-local', state })
  }

  // current BoatState (or null before the first fix) — used as the DB-less ring
  // history source, and by tests.
  function getState () { return state }
  function _ingest (delta) { onDelta(delta) } // for tests
  const _state = getState

  return { start, stop, status, handleUpgrade, getState, _ingest, _state }
}

module.exports = { createTelemetry, encodeTextFrame, SUBPROTOCOL }
