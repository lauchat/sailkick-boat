'use strict'

// Live polar performance, computed on the boat.
//
// The app already shows a live "% of polar target" on the mobile Polar screen and the
// desktop ribbon, computed in the browser. Computing it HERE instead makes it a recorded
// channel: it rides the same store-and-forward spool as every other value, so an offline
// passage replays it gapless rather than leaving a hole; it sees full-rate SignalK rather
// than the cloud's 2 s Influx poll; and it keeps working in the boat-served offline mode.
//
// The maths is NOT reimplemented — perf-live.js and polar.js are vendored verbatim from
// the app (see their headers). One definition of "the %", or the boat and the screens
// would quietly disagree.
//
// Output is two ordinary SignalK deltas:
//   performance.polarSpeed       target boat speed, m/s   (SI, as SignalK expects)
//   performance.polarSpeedRatio  achieved / target, 0–1
// Emitting deltas rather than writing our own measurement means everything downstream
// gets it for free: lib/sync already subscribes to '*' and forwards to the cloud bucket,
// NMEA displays and other plugins can read it, and the cloud maps
// performance.polarSpeedRatio -> the `perf` history channel with one line.
//
// ONLY when the guards pass. Inside the no-go wedge, in under 2 kt of wind, or against a
// near-zero target, nothing is emitted at all: a gap is the honest representation, and a
// zero would be a lie that pollutes every average drawn over it.

const fs = require('fs')
const path = require('path')
const { createLivePerf, perfPct } = require('./perf-live')
const { Polar } = require('./polar')

const OWN_PREFIX = 'own:'
const MS_TO_KT = 1.94384
const DEFAULTS = {
  intervalMs: 1000, // the 5 s EMA makes this cadence-insensitive; 1 s matches the ring
  polarReloadMs: 60000 // pick up an active-polar change without a restart
}

function createPerf (app, options = {}) {
  const log = (m) => (app.debug ? app.debug('[perf] ' + m) : console.log('[sailkick-boat:perf]', m))
  const warn = (m) => (app.error ? app.error('[sailkick-boat:perf] ' + m) : console.error('[sailkick-boat:perf]', m))

  const cfg = { ...DEFAULTS, ...options }
  let live = null
  let polar = null
  let polarId = null
  let polarError = null
  let timer = null
  let reloadTimer = null
  let stopped = false
  let last = null // { pct, target, kind, usingSog }
  let emitted = 0
  let skipped = 0
  let warnedSog = false

  // --- resolving the active polar -------------------------------------------------
  // The boat has its own profile mirror (lib/profile). `activePolar` is either an
  // own:<id> — a polar the owner authored, whose CSV is in the profile itself — or a
  // catalogue id, whose CSV the mirror has cached under store/polars/<id>.csv exactly as
  // the app fetches it.
  function readProfile () {
    try { return JSON.parse(fs.readFileSync(cfg.profileFile, 'utf8')) } catch { return null }
  }

  function csvFor (id, profile) {
    if (id.startsWith(OWN_PREFIX)) {
      const pid = id.slice(OWN_PREFIX.length)
      const item = (profile.polars || []).find((p) => p && p.id === pid)
      return item && typeof item.csv === 'string' ? item.csv : null
    }
    // Catalogue polar: whatever the mirror cached. Not fetched on demand — this must
    // work with no uplink, and an unseen polar simply means no % until the app has
    // opened it once.
    try { return fs.readFileSync(path.join(cfg.storeDir, 'polars', `${id}.csv`), 'utf8') } catch { return null }
  }

  function loadPolar () {
    const profile = readProfile()
    const id = profile && typeof profile.activePolar === 'string' ? profile.activePolar : null
    if (!id) {
      if (polarId !== null) log('no active polar selected — performance is not being computed')
      polar = null; polarId = null; polarError = 'no active polar selected'
      return
    }
    if (id === polarId && polar) return // unchanged
    const csv = csvFor(id, profile || {})
    if (!csv) {
      polar = null; polarId = id
      polarError = `the CSV for "${id}" is not on the boat yet`
      warn(`${polarError} — open the polar once in the app while online, or copy it across on the Sync page`)
      return
    }
    try {
      polar = Polar.fromCSV(id, csv)
      polarId = id
      polarError = null
      log(`active polar "${polar.name || id}" loaded (no-go ${polar.noGoTwa}°)`)
    } catch (e) {
      polar = null; polarId = id
      polarError = `polar "${id}" will not parse: ${e.message}`
      warn(polarError)
    }
  }

  // --- the computation ------------------------------------------------------------
  function tick () {
    if (stopped || !cfg.source || !cfg.source.getState) return
    const s = cfg.source.getState()
    if (!s) return

    // The SignalK timestamp, never wall clock: buffered or replayed computation has to
    // be deterministic, and the EMA is time-weighted.
    const now = Date.parse(s.updatedAt) || Date.now()
    const r = live.update(s, now)
    if (!r) { last = null; return } // wind or speed missing — the EMA reset itself

    const tws = live.avgTws(now)
    const res = perfPct(polar, tws, r.ema)

    if (live.usingSog && !warnedSog) {
      warnedSog = true
      log('no speed through water — the percentage is computed from SOG, so it is polluted by current')
    }

    if (res.kind !== 'ok') { last = { kind: res.kind }; skipped++; return }
    last = { kind: 'ok', pct: res.pct, target: res.target, usingSog: live.usingSog }
    emitted++
    emit(res, s.updatedAt)
  }

  // Standard SignalK paths, in SI. round() lives here so the ratio and the percentage
  // can never disagree: the cloud takes round(ratio * 100).
  function emit (res, timestamp) {
    if (!app.handleMessage) return
    try {
      app.handleMessage(cfg.pluginId || 'sailkick-boat', {
        updates: [{
          timestamp: timestamp || new Date().toISOString(),
          values: [
            { path: 'performance.polarSpeed', value: res.target / MS_TO_KT },
            { path: 'performance.polarSpeedRatio', value: res.pct / 100 }
          ]
        }]
      })
    } catch (e) { warn('could not emit deltas: ' + e.message) }
  }

  // --- lifecycle ------------------------------------------------------------------
  function start () {
    if (!cfg.source) { log('not started — no telemetry source'); return }
    live = createLivePerf({})
    loadPolar()
    timer = setInterval(tick, cfg.intervalMs)
    reloadTimer = setInterval(loadPolar, cfg.polarReloadMs)
    if (timer.unref) timer.unref()
    if (reloadTimer.unref) reloadTimer.unref()
    log(`computing performance every ${Math.round(cfg.intervalMs / 1000)}s -> performance.polarSpeed{,Ratio}`)
  }

  function stop () {
    stopped = true
    clearInterval(timer); clearInterval(reloadTimer)
    timer = reloadTimer = null
    live = null; polar = null; polarId = null; last = null
  }

  // What the history ring samples. Null whenever the guards did not pass, so the channel
  // gaps rather than flat-lining.
  function getPerf () { return last && last.kind === 'ok' ? last.pct : null }

  function status () {
    if (!live) return 'perf: off'
    if (polarError) return `perf: ${polarError}`
    if (!last) return 'perf: waiting for wind and speed'
    if (last.kind !== 'ok') return `perf: ${last.kind}`
    return `perf: ${last.pct}% of "${polarId}"${last.usingSog ? ' (from SOG — current-polluted)' : ''}${skipped ? `; ${skipped} guarded` : ''}`
  }

  return { start, stop, status, getPerf, _tick: tick, _polar: () => polar, _loadPolar: loadPolar, _counts: () => ({ emitted, skipped }) }
}

module.exports = { createPerf }
