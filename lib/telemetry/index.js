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
// PER-FIELD FRESHNESS. The accumulated state merges every delta into one object, so
// nothing in it ever expires: when ONE instrument dies while the others keep publishing,
// its fields freeze at their last value while `updatedAt` stays fresh, and every consumer
// treats dead data as live. Measured on this boat: the sounder lost the bottom in deep
// water and stopped publishing at 05:20, and for the hour that followed the history ring
// recorded 224.85 m every 15 s — a dead-flat plateau with a zero-width min/max band,
// which reads as "rock steady" — while the cloud, which stores only real updates, showed
// an honest gap for the same hour. Two stories about the same hour; the plateau is the
// lie. The same freeze makes a wind-speed alarm unable to fire during a wind-instrument
// outage, because it keeps seeing the last live reading.
//
// So each field carries the time it was last PATCHED, and the published view omits any
// field older than the TTL. The internal state is never mutated — filtering happens on
// read and on emit, so a returning instrument reappears on its first fresh delta.
//
// TTL: measured on this boat's bus, every path that feeds BoatState arrives at ~1 Hz with
// a worst inter-sample gap of 1.1–2.1 s (magneticVariation reaches 2.8 s from its fast
// sources). 15 s is ~7x the worst case. Critically, this subscription is FIXED-PERIOD
// ({ path: '*', period: 1000 }), and the server republishes unchanged values — proven by
// magneticVariation, gnss.satellites and propulsion.port.runTime arriving at 1 Hz with
// 100% repeated values. So a healthy-but-constant instrument (an engine at rest
// publishing rpm 0) keeps arriving and does NOT expire. A boat whose SignalK is
// configured on-change, or with a slow NMEA0183 source, could differ — hence the knob.
const FIELD_TTL_SEC = 15

// Fields that are ONE physical reading and must expire together. A position is published
// as a single navigation.position value; half a fix is not a fix, and a stale one should
// disappear whole so the anchor watch stops watching a frozen position.
const FIELD_GROUPS = [['lat', 'lon']]

// headingDeg is COMPUTED at the merge site, so it never appears in a patch and has no
// freshness of its own. Its inputs do: the compass path plus variation, or a published
// true heading. Without this it would either never expire — the frozen-heading bug
// surviving the fix — or expire always. (Note the `|| 0` fallback below, which is why a
// boat with no heading source currently reads due north rather than nothing.)
const COMPUTED_FRESHNESS = {
  headingDeg: (fresh) => (fresh('hdgMagDeg') && fresh('magVarDeg')) || fresh('hdgTrueDeg')
}

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
// DELIBERATE DIVERGENCE FROM UPSTREAM, at the owner's request.
//
// resolveHeadingDeg() in the vendored mapper now returns navigation.headingTrue when it is
// present (348c3d9, "true heading is authoritative"). That is right on CORRECTNESS — raw
// magnetic would be wrong by the local variation — but on this boat both candidates are
// true headings that agree to 0.12°, so correctness is not what separates them. Resolution
// is, and by a wide margin:
//
//   navigation.headingTrue      NMEA.31 NAIS 500      1 Hz,  quantised to 1°
//   navigation.headingMagnetic  NMEA.23 Precision-9  20 Hz,  0.006° steps
//
// The AIS transponder rounds heading to a whole degree before transmitting — normal for
// AIS, but it makes the display step once a second. The Precision-9 is the same underlying
// compass the transponder derives from, so taking it directly costs nothing in accuracy
// and gains 20x the rate.
//
// The published value is still used, as an INDEPENDENT check: if the two disagree
// materially something is broken, and the log says so. The displayed value never changes
// on the strength of that, because falling back to a 1 Hz 1° source would trade a
// suspected problem for a certainly worse reading.
//
// Handed upstream: the app's choice is about correctness and does not weigh transmission
// rounding. If it ever prefers the higher-resolution source when both are true, this whole
// block can go.
const HEADING_DISAGREE_DEG = 10

// Cross-delta precedence for fields fed by several paths.
//
// Upstream now ranks these inside signalkValuesToPatch (b519a9f) — but `courseRank` and
// `depthRank` are declared per CALL, so that ranking only orders values within ONE delta.
// On this boat the competing publishers are different sources sending SEPARATE deltas
// (courseGreatCircle from NMEA.24, course.calcValues from course-provider), so last one
// in still wins and the readout flip-flops between the two solves. Measured: 2049.48 nm
// against 2050.86 nm, several times a second.
//
// This layer remembers which path last spoke and for how long, so the precedence survives
// across deltas. It is complementary to the upstream fix, not a duplicate — delete it only
// if the ranking upstream ever becomes stateful.
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

  // See HEADING_DISAGREE_DEG. Returns TRUE heading in degrees, or undefined.
  let headingWarned = false
  function resolveHeading (st) {
    const published = Number.isFinite(st.hdgTrueDeg) ? st.hdgTrueDeg : undefined
    // Compass-derived TRUE heading. Only valid when variation is known — without it this
    // would be RAW MAGNETIC, wrong by the local declination (16° here), which is exactly
    // what upstream's 348c3d9 set out to eliminate. So no variation, no compass option.
    const compass = (Number.isFinite(st.hdgMagDeg) && Number.isFinite(st.magVarDeg))
      ? wrap360d(st.hdgMagDeg + st.magVarDeg)
      : undefined

    // Neither of ours applies — let the vendored mapper decide (it handles the remaining
    // cases, including magnetic-without-variation, however upstream judges best).
    if (compass === undefined) return published !== undefined ? published : resolveHeadingDeg(st)

    if (published !== undefined) {
      const gap = Math.abs(wrap180(published - compass))
      if (gap > HEADING_DISAGREE_DEG) {
        if (!headingWarned) {
          headingWarned = true
          const warn = app.error ? (m) => app.error('[sailkick-boat:telemetry] ' + m) : log
          warn(`navigation.headingTrue (${published.toFixed(1)}°) disagrees with the compass + variation ` +
            `(${compass.toFixed(1)}°) by ${gap.toFixed(1)}° — displaying the compass. Check which device ` +
            'publishes headingTrue, and the variation in use.')
        }
      } else if (headingWarned) {
        headingWarned = false
        log('navigation.headingTrue agrees with the compass again')
      }
    }
    return compass
  }

  // field -> ms when it was last patched. Never pruned: it is bounded by the number of
  // BoatState fields, and an entry for a field that never returns is a few bytes.
  const seenAt = {}
  const ttlMs = Math.max(1, (options.fieldTtlSec || FIELD_TTL_SEC)) * 1000

  // The ONE view every consumer sees — getState(), the update broadcast and the hello
  // frame. They must not disagree: a field the ring records but the screen omits (or the
  // reverse) is the same class of bug as the freeze itself.
  function publicState (now = Date.now()) {
    if (!state) return state
    const fresh = (k) => seenAt[k] != null && (now - seenAt[k]) < ttlMs
    const out = { updatedAt: state.updatedAt } // whole-feed staleness stays the app's job
    for (const [k, v] of Object.entries(state)) {
      if (k === 'updatedAt') continue
      const rule = COMPUTED_FRESHNESS[k]
      if (rule ? rule(fresh) : fresh(k)) out[k] = v
    }
    // Grouped fields go together or not at all.
    for (const g of FIELD_GROUPS) {
      if (g.some((k) => !(k in out))) for (const k of g) delete out[k]
    }
    return out
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
    const now = Date.now()
    for (const k of Object.keys(patch)) seenAt[k] = now
    const hd = resolveHeading(state)
    state.headingDeg = Number.isFinite(hd) ? hd : (state.headingDeg || state.cogDeg || 0)
    broadcast({ type: 'telemetry/update', state: publicState(now) })
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
    send(socket, { type: 'hello', source: 'signalk-local', state: publicState() })
  }

  // current BoatState (or null before the first fix) — used as the DB-less ring
  // history source, and by tests.
  // Filtered, like everything else. Consumers (the history ring, the alert engine, the
  // polar %) then see an absent field rather than a frozen one: the ring records a gap,
  // and the shared alert evaluator's own "cannot tell" semantics take over — which never
  // clears a raised alarm.
  function getState () { return publicState() }
  function _ingest (delta) { onDelta(delta) } // for tests
  const _state = getState
  const _rawState = () => state // tests + status: the unfiltered accumulator

  return { start, stop, status, handleUpgrade, getState, _ingest, _state, _rawState, _seenAt: () => seenAt, _publicState: publicState }
}

module.exports = { createTelemetry, encodeTextFrame, SUBPROTOCOL }
