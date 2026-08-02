'use strict'

// AIS upload — forward the targets this boat's own receiver hears, so the cloud app can
// draw other vessels, their heading and their trail.
//
// The cloud already renders AIS (public/viewer/ais.js → /api/ais), but its source polls a
// SignalK server over the LAN and keeps everything in memory. That only works while the
// cloud can reach the boat inbound, which stops being true on a mobile link. So the boat
// pushes instead.
//
// Only LOCALLY RECEIVED AIS is worth uploading. A boat running an internet feed like
// signalk-aisstream would otherwise spend uplink bandwidth sending data the cloud could
// fetch directly from the same API over a fat pipe. The value is what your own VHF hears
// offshore, where commercial feeds are blind — which is also why there is no radius or
// rate limit here: VHF line-of-sight is the honest limiter, and offshore it tends to zero.
//
// Two invariants this module must not break:
//   - Telemetry always wins the link. Separate spool, separate uploader, and it stands
//     down whenever the telemetry spool has a backlog.
//   - Every row is tagged self=false. The cloud's history queries filter on self=="true"
//     to keep other vessels out of the boat's own Trends and track; if that tag were
//     wrong, AIS would land in the owner's SOG and heading charts.

const fs = require('fs')
const path = require('path')
const { Spool } = require('../sync/spool')
const { writeLines } = require('../sync/influxWrite')
const { deltaToLines } = require('../sync/lineprotocol')

// What the cloud's /api/ais envelope needs. Subscribing to these rather than '*' keeps
// delta volume down without imposing a rate limit.
const POSITION_PATHS = [
  'navigation.position',
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.magneticVariation',
  'navigation.rateOfTurn'
]
// Static/identity data: repeats every ~6 min per vessel and essentially never changes.
const STATIC_PATHS = ['design.length', 'design.beam', 'design.aisShipType']
const ALL_PATHS = [...POSITION_PATHS, ...STATIC_PATHS]

// Sources that are internet feeds rather than a receiver on this boat. Uploading these
// is pure round-tripping. Matched case-insensitively as a substring of $source.
const INTERNET_FEEDS = ['aisstream', 'aishub', 'marinetraffic', 'vesselfinder']

const DEFAULTS = {
  staticIntervalMs: 3600000, // re-send a vessel's identity at most hourly
  flushIntervalMs: 5000,
  batchSize: 2000,
  maxBufferBytes: 50 * 1024 * 1024, // its own, smaller cap — see below
  idlePollMs: 5000,
  retryMinMs: 2000,
  retryMaxMs: 120000,
  requestTimeoutMs: 30000
}

const isInternetFeed = (src) => {
  const s = String(src || '').toLowerCase()
  return INTERNET_FEEDS.some((f) => s.includes(f))
}

function createAis (app, options) {
  const log = (m) => (app.debug ? app.debug('[ais] ' + m) : console.log('[sailkick-boat:ais]', m))
  const warn = (m) => (app.error ? app.error('[sailkick-boat:ais] ' + m) : console.error('[sailkick-boat:ais]', m))

  const cfg = { ...DEFAULTS, ...options }
  let state = null

  function start () {
    if (!cfg.influxUrl || !cfg.bucket || !cfg.token) {
      warn('not started — the boat is not paired, so there is no destination bucket')
      state = { statusLine: 'ais: not configured', stopped: true }
      return
    }
    const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
    // A SEPARATE spool. Sharing the telemetry one would be dangerous: it drops the
    // OLDEST files on overflow, so an AIS flood in a busy anchorage could evict
    // telemetry that had not been sent yet.
    const spoolDir = cfg.spoolDir || path.join(dataDir, 'ais-spool')
    const spool = new Spool({ dir: spoolDir, maxBytes: cfg.maxBufferBytes, logger: log })
    const selfContext = app.selfContext || ('vessels.' + (app.selfId || 'self'))

    state = {
      spool,
      selfContext,
      batch: [],
      lastStatic: new Map(), // context -> ms, so identity is re-sent at most hourly
      sourcesSeen: new Map(), // $source -> count, for the discovery log
      targets: new Set(),
      forwarded: 0,
      dropped: 0,
      lastOkAt: null,
      backoff: cfg.retryMinMs,
      pumping: false,
      stopped: false,
      unsubscribes: [],
      statusLine: 'ais: starting'
    }

    spool.init().then(() => {
      // stop() can land before init resolves (disable during startup, or a fast
      // restart). Without this the timers are installed on an already-stopped module
      // and never cleared — a leaked interval that also keeps the host process alive.
      if (!state || state.stopped) return
      state.flushTimer = setInterval(flush, cfg.flushIntervalMs)
      state.reportTimer = setInterval(reportSources, 300000)
      // Unref every timer: this module must never be the reason the Signal K server
      // cannot exit.
      if (state.flushTimer.unref) state.flushTimer.unref()
      if (state.reportTimer.unref) state.reportTimer.unref()
      subscribe()
      pump()
      log(`started; ${cfg.source ? 'source "' + cfg.source + '" only' : 'all sources except known internet feeds'}; buffer ${spoolDir}`)
    }).catch((e) => warn('init failed: ' + e.message))
  }

  // Which $source values are actually producing AIS, so the config field can be filled
  // in from the log instead of guessed.
  function reportSources () {
    if (!state || !state.sourcesSeen.size) return
    const list = [...state.sourcesSeen.entries()].sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s} (${n}${isInternetFeed(s) ? ', internet feed — not forwarded' : ''})`)
    log('AIS sources seen: ' + list.join('; '))
  }

  function accept (context, source) {
    if (!context || context === state.selfContext) return false // never our own vessel
    if (cfg.source) return String(source) === String(cfg.source)
    return !isInternetFeed(source)
  }

  function handleDelta (delta) {
    if (!state || state.stopped || !delta || !Array.isArray(delta.updates)) return
    const context = delta.context
    if (!context || context === state.selfContext) return

    for (const update of delta.updates) {
      if (!update || !Array.isArray(update.values)) continue
      const source = update.$source || (update.source && (update.source.label || update.source.type)) || 'unknown'
      state.sourcesSeen.set(source, (state.sourcesSeen.get(source) || 0) + 1)
      if (!accept(context, source)) { state.dropped++; continue }

      // Split identity from position: identity repeats constantly and never changes.
      const now = Date.now()
      const staticDue = (now - (state.lastStatic.get(context) || 0)) >= cfg.staticIntervalMs
      const values = update.values.filter((pv) => {
        if (!pv || !pv.path) return false
        if (STATIC_PATHS.includes(pv.path)) return staticDue
        return POSITION_PATHS.includes(pv.path)
      })
      if (!values.length) continue
      if (staticDue && values.some((pv) => STATIC_PATHS.includes(pv.path))) state.lastStatic.set(context, now)

      // self:false is the tag the cloud filters on to keep AIS out of the owner's charts.
      const lines = deltaToLines({ context, updates: [{ ...update, values }] }, { self: false })
      if (lines.length) {
        state.batch.push(...lines)
        state.targets.add(context)
        state.forwarded += lines.length
      }
      if (state.batch.length >= cfg.batchSize) flush()
    }
  }

  function subscribe () {
    const sub = { context: '*', subscribe: ALL_PATHS.map((p) => ({ path: p, period: cfg.periodMs || 10000 })) }
    if (app.subscriptionmanager && app.subscriptionmanager.subscribe) {
      app.subscriptionmanager.subscribe(sub, state.unsubscribes, (err) => warn('subscription error: ' + err), handleDelta)
    } else if (app.signalk && app.signalk.on) {
      const h = (d) => handleDelta(d)
      app.signalk.on('delta', h)
      state.unsubscribes.push(() => app.signalk.removeListener('delta', h))
    } else {
      warn('no subscription mechanism available — nothing will be forwarded')
    }
  }

  function flush () {
    if (!state || state.stopped || !state.batch.length) return
    const lines = state.batch
    state.batch = []
    state.spool.append(lines).then(() => pump()).catch((e) => {
      warn('spool append failed: ' + e.message)
      state.batch.unshift(...lines)
    })
  }

  async function pump () {
    if (!state || state.stopped || state.pumping) return
    // Telemetry always wins the link: stand down entirely while its spool is behind.
    if (cfg.pending) {
      let depth = 0
      try { depth = (await cfg.pending()).count || 0 } catch {}
      if (depth) { refreshStatus(`waiting — telemetry backlog (${depth})`); scheduleIdle(); return }
    }
    state.pumping = true
    try {
      for (const file of await state.spool.pending()) {
        if (state.stopped) break
        let body
        try { body = await fs.promises.readFile(file, 'utf8') } catch { continue }
        if (!body.trim()) { await state.spool.remove(file); continue }
        const res = await writeLines({ influxUrl: cfg.influxUrl, org: cfg.org, bucket: cfg.bucket, token: cfg.token, timeoutMs: cfg.requestTimeoutMs }, body)
        if (res.ok) {
          await state.spool.remove(file); state.lastOkAt = new Date(); state.backoff = cfg.retryMinMs
        } else if (res.retryable) {
          state.pumping = false; scheduleRetry(res); return
        } else {
          warn(`batch rejected (HTTP ${res.status}) — quarantined`)
          await state.spool.quarantine(file)
        }
      }
    } catch (e) {
      warn('pump error: ' + e.message); state.pumping = false; scheduleRetry(); return
    }
    state.pumping = false
    scheduleIdle()
    refreshStatus()
  }

  function scheduleRetry (res) {
    if (!state || state.stopped) return
    clearTimeout(state.pumpTimer)
    const delay = state.backoff
    state.backoff = Math.min(state.backoff * 2, cfg.retryMaxMs)
    state.pumpTimer = setTimeout(pump, delay)
    if (state.pumpTimer.unref) state.pumpTimer.unref()
    refreshStatus(`${res && res.status ? 'HTTP ' + res.status : 'offline'} — retry ${Math.round(delay / 1000)}s`)
  }
  function scheduleIdle () {
    if (!state || state.stopped) return
    clearTimeout(state.pumpTimer)
    state.pumpTimer = setTimeout(pump, cfg.idlePollMs)
    if (state.pumpTimer.unref) state.pumpTimer.unref()
  }
  function refreshStatus (suffix) {
    if (!state) return
    state.statusLine = `ais: ${state.targets.size} target(s), ${state.forwarded} point(s)${state.dropped ? `, ${state.dropped} skipped` : ''}${suffix ? '; ' + suffix : ''}`
  }

  function stop () {
    if (!state) return
    state.stopped = true
    clearInterval(state.flushTimer)
    clearInterval(state.reportTimer)
    clearTimeout(state.pumpTimer)
    for (const u of (state.unsubscribes || [])) { try { u() } catch {} }
    if (state.batch && state.batch.length && state.spool) {
      try { fs.writeFileSync(path.join(state.spool.dir, `${Date.now()}-final.lp`), state.batch.join('\n') + '\n') } catch {}
      state.batch = []
    }
  }

  function status () { return state ? state.statusLine : 'ais: off' }

  return { start, stop, status, _handleDelta: handleDelta, _state: () => state, _flush: flush }
}

module.exports = { createAis, isInternetFeed, POSITION_PATHS, STATIC_PATHS }
