'use strict'

// Serve the app's GET /api/ais from the boat's OWN SignalK, so other vessels appear on
// the chart with no uplink at all.
//
// Ported from the cloud's server/ais/service.js — same polling shape, same trail rules,
// same JSON envelope — so public/viewer/ais.js cannot tell the difference. Keep the
// field set and the trail thresholds in step with that copy.
//
// This is the counterpart of lib/ais/index.js, not a duplicate of it: that one pushes
// AIS to the cloud so the boat's surroundings can be seen from shore; this one answers
// the browser sitting on the boat. Offshore, only this one can work — and it is the more
// valuable of the two, since AIS targets on your own chart matter most exactly when
// there is no connectivity.
//
// Why not reuse the upload module's delta stream? It subscribes only to the paths it
// forwards, and a vessel's NAME arrives as a vessel-level delta (empty path) which that
// path list deliberately ignores. Polling the REST tree gets identity and dimensions
// without a second subscription, exactly as the cloud does.

const MS_TO_KT = 1.94384
const R2D = 180 / Math.PI
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)
const wrap360 = (d) => ((d % 360) + 360) % 360

// ws/wss/http, with or without a /signalk path → REST origin.
function restOrigin (url) {
  return String(url || '').trim()
    .replace(/\/+$/, '')
    .replace(/\/signalk\/.*$/i, '')
    .replace(/^ws(s?):\/\//i, 'http$1://')
}

function haversineM (lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180
  const R = 6371000
  const dLat = (lat2 - lat1) * toR
  const dLon = (lon2 - lon1) * toR
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function createAisTargets (app, options = {}) {
  const log = (m) => (app.debug ? app.debug('[ais-targets] ' + m) : console.log('[sailkick-boat:ais-targets]', m))
  const cfg = {
    url: options.localSignalkUrl || 'http://127.0.0.1:3000',
    pollMs: options.pollMs || 10000,
    trailMs: options.trailMs || 3600000, // ~1 h of trail
    trailMinMoveM: options.trailMinMoveM || 30, // a point only after moving this far
    trailMaxPoints: options.trailMaxPoints || 240,
    staleMs: options.staleMs || 15 * 60000 // drop a vessel unseen for this long
  }
  const base = restOrigin(cfg.url)
  const state = new Map() // mmsi -> record
  let selfMmsi = null
  let lastPollAt = null
  let lastError = null
  let stopped = false
  let timer = null

  async function fetchSelf () {
    try {
      const r = await fetch(`${base}/signalk/v1/api/self`, { signal: AbortSignal.timeout(5000) })
      if (r.ok) selfMmsi = String(await r.json()).split(':').pop() // "vessels.urn:…:mmsi:<n>"
    } catch { /* retry next poll */ }
  }

  function ingest (vessels) {
    const now = Date.now()
    for (const [key, v] of Object.entries(vessels || {})) {
      const mmsi = String(key).split(':').pop()
      if (!mmsi || mmsi === selfMmsi) continue
      const p = v && v.navigation && v.navigation.position && v.navigation.position.value
      if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue
      // The AIS message's own time, beside .value — the poll cadence is not the age of
      // the report.
      const posTs = Date.parse(v.navigation.position.timestamp) || now

      const cog = num(v.navigation.courseOverGroundTrue && v.navigation.courseOverGroundTrue.value)
      const hT = num(v.navigation.headingTrue && v.navigation.headingTrue.value)
      const hM = num(v.navigation.headingMagnetic && v.navigation.headingMagnetic.value)
      const varn = num(v.navigation.magneticVariation && v.navigation.magneticVariation.value)
      const headingDeg = hT != null ? wrap360(hT * R2D) : hM != null ? wrap360((hM + (varn || 0)) * R2D) : null

      const rec = state.get(mmsi) || { mmsi, trail: [] }
      // SignalK exposes `name` as a bare string, not the usual {value} wrapper.
      rec.name = (typeof v.name === 'string' ? v.name : v.name && v.name.value) || rec.name || null
      rec.lat = p.latitude
      rec.lon = p.longitude
      const sog = num(v.navigation.speedOverGround && v.navigation.speedOverGround.value)
      rec.sogKt = sog != null ? +(sog * MS_TO_KT).toFixed(1) : null
      rec.cogDeg = cog != null ? wrap360(cog * R2D) : null
      rec.headingDeg = headingDeg
      const len = v.design && v.design.length && v.design.length.value
      rec.loaM = num(len && (len.overall != null ? len.overall : len.hull != null ? len.hull : len))
      rec.beamM = num(v.design && v.design.beam && v.design.beam.value)
      const at = v.design && v.design.aisShipType && v.design.aisShipType.value // { id, name } | id
      rec.shipType = (at && typeof at === 'object' ? at.name : null) || rec.shipType || null
      rec.aisType = (typeof at === 'number' ? at : num(at && at.id)) || rec.aisType || null
      rec.rotRadS = num(v.navigation.rateOfTurn && v.navigation.rateOfTurn.value)
      rec.posTs = posTs
      rec.updatedAt = now

      // Trail: a point only once the vessel has actually moved, so anchored ships stay a
      // single dot instead of a jittering cloud.
      const last = rec.trail[rec.trail.length - 1]
      if (!last || haversineM(last[0], last[1], p.latitude, p.longitude) > cfg.trailMinMoveM) {
        rec.trail.push([p.latitude, p.longitude, now])
      }
      const cutoff = now - cfg.trailMs
      while (rec.trail.length && rec.trail[0][2] < cutoff) rec.trail.shift()
      if (rec.trail.length > cfg.trailMaxPoints) rec.trail.splice(0, rec.trail.length - cfg.trailMaxPoints)

      state.set(mmsi, rec)
    }
  }

  async function poll () {
    if (stopped) return
    try {
      if (!selfMmsi) await fetchSelf()
      const r = await fetch(`${base}/signalk/v1/api/vessels`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(`vessels ${r.status}`)
      ingest(await r.json())
      lastPollAt = Date.now()
      lastError = null
    } catch (e) {
      lastError = e.message // a failed poll keeps the last snapshot; never throws
    } finally {
      if (!stopped) { timer = setTimeout(poll, cfg.pollMs); if (timer.unref) timer.unref() }
    }
  }

  function getVessels () {
    const cutoff = Date.now() - cfg.staleMs
    const vessels = []
    for (const rec of state.values()) {
      if (rec.updatedAt < cutoff) { state.delete(rec.mmsi); continue }
      vessels.push({
        mmsi: rec.mmsi, name: rec.name, lat: rec.lat, lon: rec.lon,
        sogKt: rec.sogKt, cogDeg: rec.cogDeg, headingDeg: rec.headingDeg, rotRadS: rec.rotRadS,
        loaM: rec.loaM, beamM: rec.beamM, shipType: rec.shipType, aisType: rec.aisType,
        posTs: rec.posTs, updatedAt: rec.updatedAt,
        trail: rec.trail.map((q) => [q[0], q[1]])
      })
    }
    return { polledAt: lastPollAt, error: lastError, count: vessels.length, vessels }
  }

  function start () { log(`polling ${base}/signalk/v1/api/vessels every ${Math.round(cfg.pollMs / 1000)}s`); poll() }
  function stop () { stopped = true; if (timer) clearTimeout(timer) }
  function available () { return true } // SignalK is local; a failed poll just serves the last snapshot

  // GET /api/ais — byte-for-byte the envelope the cloud returns.
  function handleAis (req, res) {
    const body = JSON.stringify({ available: true, ...getVessels() })
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function status () {
    const n = state.size
    const age = lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) + 's ago' : 'never'
    return `ais targets: ${n} vessel(s), polled ${age}${lastError ? ' (' + lastError + ')' : ''}`
  }

  return { start, stop, status, available, handleAis, getVessels, _ingest: ingest, _state: () => state }
}

module.exports = { createAisTargets, restOrigin, haversineM }
