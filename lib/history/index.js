'use strict'

// History module — serves the sailkick app's GET /api/history/series and
// /api/history/track from the boat's LOCAL InfluxDB (a signalk-to-influxdb-v2
// style bucket), so the app's Trends panel + track work offline with the full
// local dataset.
//
// This is the boat-edge counterpart of the app's server/history/influx-provider.js:
// the Flux queries and channel map are ported VERBATIM (the signalk-to-influxdb-v2 schema —
// measurement=SignalK path, field="value", position→lat/lon — is exactly what that
// provider assumes), and the JSON envelope is byte-for-byte the same the app's
// server/routes/history.js returns, so the browser client can't tell the difference.
// Keep MAP / the queries in sync with the app copy.
//
// When no local InfluxDB is configured (e.g. SignalK on a Victron GX / Venus OS)
// but a telemetry source is available, it instead serves a DB-less in-memory ring
// (lib/history/ring.js) — same JSON contract, ~1h offline window, no database.

const path = require('path')
const { RingHistoryProvider } = require('./ring')

const MS_TO_KT = 1.94384
const RAD2DEG = 180 / Math.PI
const wrap360 = (d) => ((d % 360) + 360) % 360
const wrap180 = (d) => { const x = wrap360(d); return x > 180 ? x - 360 : x }

// SignalK path (Influx measurement) → { chan, conv }. Field key is "value".
// Some channels have a fallback measurement (primary wins when both present).
const MAP = {
  'environment.wind.speedTrue': { chan: 'tws', conv: (v) => v * MS_TO_KT },
  'environment.wind.directionTrue': { chan: 'twd', conv: (v) => wrap360(v * RAD2DEG) },
  'environment.wind.speedApparent': { chan: 'aws', conv: (v) => v * MS_TO_KT },
  'environment.wind.angleApparent': { chan: 'awa', conv: (v) => wrap180(v * RAD2DEG) },
  'navigation.speedOverGround': { chan: 'sog', conv: (v) => v * MS_TO_KT },
  'navigation.speedThroughWater': { chan: 'stw', conv: (v) => v * MS_TO_KT },
  'navigation.headingTrue': { chan: 'heading', conv: (v) => wrap360(v * RAD2DEG) },
  'navigation.headingMagnetic': { chan: 'heading', conv: (v) => wrap360(v * RAD2DEG), fallback: true },
  'environment.depth.belowTransducer': { chan: 'depth', conv: (v) => v },
  'environment.depth.belowSurface': { chan: 'depth', conv: (v) => v, fallback: true }
}
const MEASUREMENTS = Object.keys(MAP)

// Parse a duration like "1h" / "30m" / "600s" / "3600" → seconds, clamped.
// Ported from the app's server/routes/history.js so limits match exactly.
function dur (s, def, min, max) {
  if (s == null) return def
  const m = String(s).trim().match(/^(\d+)\s*([smh]?)$/)
  if (!m) return def
  const n = parseInt(m[1], 10) * ({ s: 1, m: 60, h: 3600, '': 1 }[m[2]])
  return Math.max(min, Math.min(max, n))
}

// Minimal InfluxDB v2 annotated-CSV parser (same approach as the app's
// server/influx/client.js). Values in our long-format queries are simple.
function parseAnnotatedCsv (text) {
  const rows = []
  let header = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line || line.startsWith('#')) { header = null; continue }
    const cols = line.split(',')
    if (!header) { header = cols; continue }
    const o = {}
    for (let i = 0; i < header.length; i++) o[header[i]] = cols[i]
    rows.push(o)
  }
  return rows
}

function createHistory (app, options) {
  const log = (m) => (app.debug ? app.debug('[history] ' + m) : console.log('[sailkick-boat:history]', m))
  let cfg = null
  let provider = null // { getSeries, getTrack, destroy? } — InfluxDB queries or the ring
  let mode = null // 'influx' | 'ring' | null

  function start () {
    cfg = {
      url: (options.influxUrl || 'http://127.0.0.1:8086').replace(/\/+$/, ''),
      org: options.org || 'signalk',
      bucket: options.bucket || 'signalk',
      token: options.token || '',
      timeoutMs: options.requestTimeoutMs || 15000
    }
    if (cfg.url && cfg.token && cfg.bucket) {
      // Full history from a local InfluxDB.
      provider = { getSeries: influxSeries, getTrack: influxTrack }
      mode = 'influx'
      log(`serving /api/history from ${cfg.url} bucket "${cfg.bucket}"`)
    } else if (options.ringSource && options.ringSource.getState) {
      // No local InfluxDB → DB-less rolling ring from live telemetry (GX/Venus OS).
      // Persist the append-log so it survives restarts (unless ringPersist is off).
      // Default location: a "history" folder under the tile cache dir (storeDir), so it
      // sits on the SSD/USB with the tiles; `ringDir` overrides. Resolve storeDir the
      // same way the proxy does.
      const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
      const storeDir = options.storeDir || path.join(dataDir, 'store')
      const ringDir = options.ringDir || path.join(storeDir, 'history')
      const persistFile = options.ringPersist !== false ? path.join(ringDir, 'history-ring.jsonl') : null
      provider = new RingHistoryProvider({
        source: options.ringSource,
        windowSec: options.ringWindowSec,
        sampleSec: options.ringSampleSec,
        persistFile
      })
      mode = 'ring'
      log(persistFile
        ? `serving /api/history from a persistent DB-less ring (${persistFile})`
        : 'serving /api/history from an in-memory DB-less ring')
    } else {
      provider = null; mode = null
      log('no local InfluxDB and no telemetry — /api/history falls through to the mirror')
    }
  }

  function stop () {
    try { if (provider && provider.destroy) provider.destroy() } catch {}
    provider = null; mode = null; cfg = null
  }

  // available() gates local serving: when false the proxy lets /api/history fall
  // through to the cloud mirror (so we never make history worse than today).
  function available () { return !!provider }

  function status () {
    if (!provider) return 'history: off'
    return mode === 'ring' ? `history: ring${provider._persistFile ? ' (persistent)' : ''}` : `history: ${cfg.bucket}@local`
  }

  async function queryFlux (flux, signal) {
    const url = `${cfg.url}/api/v2/query?org=${encodeURIComponent(cfg.org)}`
    let resp
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${cfg.token}`, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' },
        body: flux,
        signal: signal || AbortSignal.timeout(cfg.timeoutMs)
      })
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, status: 0, message: 'InfluxDB query aborted/timed out' }
      return { ok: false, status: 502, message: `Network error talking to InfluxDB: ${e.message}` }
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      return { ok: false, status: resp.status, message: `InfluxDB ${resp.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true, rows: parseAnnotatedCsv(await resp.text()) }
  }

  async function influxSeries ({ windowSec, everySec, signal }) {
    const filt = MEASUREMENTS.map((m) => `r._measurement == "${m}"`).join(' or ')
    const flux = `from(bucket: "${cfg.bucket}")
  |> range(start: -${windowSec}s)
  |> filter(fn: (r) => r._field == "value" and (${filt}))
  |> aggregateWindow(every: ${everySec}s, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value", "_measurement"])`
    const r = await queryFlux(flux, signal)
    if (!r.ok) return r

    const byChan = {} // chan -> { primary:[[t,v]], fallback:[[t,v]] }
    for (const row of r.rows) {
      const spec = MAP[row._measurement]
      if (!spec) continue
      const t = Date.parse(row._time)
      const v = Number(row._value)
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue
      const slot = (byChan[spec.chan] || (byChan[spec.chan] = { primary: [], fallback: [] }))
      ;(spec.fallback ? slot.fallback : slot.primary).push([t, spec.conv(v)])
    }
    const series = {}
    for (const [chan, { primary, fallback }] of Object.entries(byChan)) {
      const pts = (primary.length ? primary : fallback).sort((a, b) => a[0] - b[0])
      if (pts.length) series[chan] = pts
    }
    return { ok: true, series }
  }

  async function influxTrack ({ windowSec, everySec = 30, signal }) {
    const flux = `from(bucket: "${cfg.bucket}")
  |> range(start: -${windowSec}s)
  |> filter(fn: (r) => r._measurement == "navigation.position" and (r._field == "lat" or r._field == "lon"))
  |> aggregateWindow(every: ${everySec}s, fn: last, createEmpty: false)
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> keep(columns: ["_time", "lat", "lon"])`
    const r = await queryFlux(flux, signal)
    if (!r.ok) return r
    const track = []
    for (const row of r.rows) {
      const t = Date.parse(row._time)
      const lat = Number(row.lat)
      const lon = Number(row.lon)
      if (Number.isFinite(t) && Number.isFinite(lat) && Number.isFinite(lon)) track.push({ t, lat, lon })
    }
    track.sort((a, b) => a.t - b.t)
    return { ok: true, track }
  }

  // Abort the Influx query if the client disconnects mid-request.
  function abortOnClose (res) {
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableFinished) ac.abort() })
    return ac.signal
  }

  function query (reqUrl) {
    const qi = reqUrl.indexOf('?')
    return new URLSearchParams(qi >= 0 ? reqUrl.slice(qi + 1) : '')
  }

  function sendJson (res, status, obj) {
    const body = JSON.stringify(obj)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(body)
  }

  async function handleSeries (req, res) {
    if (!available()) return sendJson(res, 503, { ok: false, code: 'history-unavailable', message: 'history not available' })
    const q = query(req.url)
    const windowSec = dur(q.get('window'), 3600, 60, 86400)
    const everySec = dur(q.get('every'), 30, 5, 600)
    try {
      const r = await provider.getSeries({ windowSec, everySec, signal: abortOnClose(res) })
      if (!r.ok) return sendJson(res, r.status || 502, { ok: false, code: 'history-error', message: r.message })
      sendJson(res, 200, { ok: true, windowSec, everySec, from: Date.now() - windowSec * 1000, to: Date.now(), series: r.series })
    } catch (e) {
      sendJson(res, 502, { ok: false, code: 'history-error', message: e.message })
    }
  }

  async function handleTrack (req, res) {
    if (!available()) return sendJson(res, 503, { ok: false, code: 'history-unavailable', message: 'history not available' })
    const q = query(req.url)
    const windowSec = dur(q.get('window'), 3600, 60, 86400)
    try {
      const r = await provider.getTrack({ windowSec, signal: abortOnClose(res) })
      if (!r.ok) return sendJson(res, r.status || 502, { ok: false, code: 'history-error', message: r.message })
      sendJson(res, 200, { ok: true, windowSec, track: r.track })
    } catch (e) {
      sendJson(res, 502, { ok: false, code: 'history-error', message: e.message })
    }
  }

  return { start, stop, status, available, handleSeries, handleTrack, _mode: () => mode, _getSeries: influxSeries, _getTrack: influxTrack }
}

module.exports = { createHistory }
