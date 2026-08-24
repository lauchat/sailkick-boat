'use strict'

// History module — serves the sailkick app's GET /api/history/series and
// /api/history/track from the boat's own LIVE data, so the Trends panel and the track
// work offline. The JSON envelope is byte-for-byte what the app's
// server/routes/history.js returns, so the browser can't tell the difference.
//
// There is exactly ONE source: the DB-less ring (lib/history/ring.js), sampled from the
// same BoatState that feeds /ws/telemetry.
//
// Until v0.15.0 a local InfluxDB could be configured here instead, and it won because a
// read token was present. That was a trap: the app only ever asks for a RELATIVE window
// clamped to 24 h (sailkick/server/routes/history.js), so pointing this at a bucket of
// older data returned nothing at all — Trends went blank AND the working live ring was
// switched off. Local history is now always live; an old InfluxDB's value is getting its
// contents INTO the cloud, which is what lib/backfill is for.

const path = require('path')
const { RingHistoryProvider } = require('./ring')

const MS_TO_KT = 1.94384
const RAD2DEG = 180 / Math.PI
const wrap360 = (d) => ((d % 360) + 360) % 360
const wrap180 = (d) => { const x = wrap360(d); return x > 180 ? x - 360 : x }


// Parse a duration like "1h" / "30m" / "600s" / "3600" → seconds, clamped.
// Ported from the app's server/routes/history.js so limits match exactly.
function dur (s, def, min, max) {
  if (s == null) return def
  const m = String(s).trim().match(/^(\d+)\s*([smh]?)$/)
  if (!m) return def
  const n = parseInt(m[1], 10) * ({ s: 1, m: 60, h: 3600, '': 1 }[m[2]])
  return Math.max(min, Math.min(max, n))
}


function createHistory (app, options) {
  const log = (m) => (app.debug ? app.debug('[history] ' + m) : console.log('[sailkick-boat:history]', m))
  let provider = null // the ring, or null when there is no telemetry to sample

  function start () {
    if (options.ringSource && options.ringSource.getState) {
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
        perfSource: options.perfSource || null, // lib/perf — the computed polar %
        windowSec: options.ringWindowSec,
        sampleSec: options.ringSampleSec,
        persistFile
      })
      log(persistFile
        ? `serving /api/history from a persistent ring (${persistFile})`
        : 'serving /api/history from an in-memory ring')
    } else {
      provider = null
      log('no telemetry source — /api/history falls through to the cloud mirror')
    }
  }

  function stop () {
    try { if (provider && provider.destroy) provider.destroy() } catch {}
    provider = null
  }

  // available() gates local serving: when false the proxy lets /api/history fall
  // through to the cloud mirror (so we never make history worse than today).
  function available () { return !!provider }

  function status () {
    if (!provider) return 'history: off'
    return `history: ring${provider._persistFile ? ' (persistent)' : ''}`
  }

  // Abort the query if the client disconnects mid-request.
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

  // An ABSOLUTE range, which the app sends whenever the view is scrolled back in time —
  // the historic trail and a Trends flyout both call fetchTrack/fetchSeries with
  // `from=<ms>&to=<ms>` (app public/engine/history-client.js), and the cloud provider
  // takes the same pair. The boat used to parse only `window`, so a request for a past
  // hour returned the MOST RECENT hour with a 200: the trail showed the current hour
  // dressed as history instead of failing visibly.
  //
  // Epoch ms or ISO, both accepted. Returns null unless both ends resolve and the span
  // runs forwards — a malformed pair falls back to the trailing window rather than 400,
  // because a still-drawn trail beats a broken screen at sea.
  function absRange (q) {
    const at = (v) => {
      if (v == null || v === '') return null
      const n = Number(v)
      if (Number.isFinite(n) && n > 1e11) return n // epoch ms (anything later than 1973)
      const d = Date.parse(v)
      return Number.isFinite(d) ? d : null
    }
    const fromMs = at(q.get('from'))
    if (fromMs == null) return null
    const toMs = at(q.get('to')) ?? Date.now() // `from` alone means "from then until now"
    if (toMs <= fromMs) return null
    return { fromMs, toMs }
  }

  async function handleSeries (req, res) {
    if (!available()) return sendJson(res, 503, { ok: false, code: 'history-unavailable', message: 'history not available' })
    const q = query(req.url)
    const windowSec = dur(q.get('window'), 3600, 60, 86400)
    const everySec = dur(q.get('every'), 30, 5, 600)
    const abs = absRange(q)
    try {
      const r = await provider.getSeries({ windowSec, everySec, ...(abs || {}), signal: abortOnClose(res) })
      if (!r.ok) return sendJson(res, r.status || 502, { ok: false, code: 'history-error', message: r.message })
      sendJson(res, 200, {
        ok: true,
        windowSec,
        everySec,
        // Echo the range actually served, so the client can tell it was honoured.
        from: abs ? abs.fromMs : Date.now() - windowSec * 1000,
        to: abs ? abs.toMs : Date.now(),
        series: r.series
      })
    } catch (e) {
      sendJson(res, 502, { ok: false, code: 'history-error', message: e.message })
    }
  }

  async function handleTrack (req, res) {
    if (!available()) return sendJson(res, 503, { ok: false, code: 'history-unavailable', message: 'history not available' })
    const q = query(req.url)
    const windowSec = dur(q.get('window'), 3600, 60, 86400)
    // Thinning is optional here: the cloud accepts `every` on the track and the app sends
    // it for long spans. Unset means every sample, which is what the live trail wants.
    const everySec = q.get('every') ? dur(q.get('every'), 30, 1, 3600) : null
    const abs = absRange(q)
    try {
      const r = await provider.getTrack({ windowSec, everySec, ...(abs || {}), signal: abortOnClose(res) })
      if (!r.ok) return sendJson(res, r.status || 502, { ok: false, code: 'history-error', message: r.message })
      sendJson(res, 200, {
        ok: true,
        windowSec,
        from: abs ? abs.fromMs : Date.now() - windowSec * 1000,
        to: abs ? abs.toMs : Date.now(),
        track: r.track
      })
    } catch (e) {
      sendJson(res, 502, { ok: false, code: 'history-error', message: e.message })
    }
  }

  return { start, stop, status, available, handleSeries, handleTrack, _provider: () => provider }
}

module.exports = { createHistory }
