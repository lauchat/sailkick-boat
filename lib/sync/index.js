'use strict'

// Telemetry sync module: durable, gapless store-and-forward of self-vessel data
// to InfluxDB v2 (survives offline periods + Signal K restarts). Lifted verbatim
// from signalk-to-influxdb-gapless, wrapped as createSync(app, options) ->
// { start, stop, status } so it can live alongside the proxy module in one plugin.

const fs = require('fs')
const path = require('path')
const { Spool, DEFAULT_MAX_BYTES } = require('./spool')
const { writeLines } = require('./influxWrite')
const { deltaToLines } = require('./lineprotocol')

function createSync (app, options) {
  const log = (m) => (app.debug ? app.debug('[sync] ' + m) : console.log('[sailkick-boat:sync]', m))
  // Anything that stops telemetry reaching the cloud goes to `warn`, which lands in the
  // normal server log. `log` is behind the plugin's debug key and is for detail only —
  // an outage must never be visible ONLY in the status line, which is what made a
  // day-long silent failure possible.
  const warn = (m) => (app.error ? app.error('[sailkick-boat:sync] ' + m) : console.error('[sailkick-boat:sync]', m))
  const WARN_REPEAT_MS = 300000 // re-state an ongoing outage every 5 min, not every retry
  let state = null

  function start () {
    const cfg = {
      influxUrl: options.influxUrl,
      org: options.org || 'sailkick',
      bucket: options.bucket,
      token: options.token,
      timeoutMs: options.requestTimeoutMs || 30000
    }
    if (!cfg.influxUrl || !cfg.bucket || !cfg.token) {
      const missing = [!cfg.influxUrl && 'influxUrl', !cfg.bucket && 'bucket', !cfg.token && 'write token'].filter(Boolean)
      warn(`not started — missing ${missing.join(' + ')}. Telemetry is NOT being sent.`)
      state = { statusLine: `sync: not configured (missing ${missing.join(', ')})`, stopped: true }
      return
    }

    const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
    const spoolDir = options.spoolDir || path.join(dataDir, 'spool')
    const spool = new Spool({ dir: spoolDir, maxBytes: options.maxBufferBytes || DEFAULT_MAX_BYTES, logger: log })
    const selfContext = app.selfContext || ('vessels.' + (app.selfId || 'self'))

    state = {
      cfg, spool, log, batch: [], batchSize: options.batchSize || 1000,
      flushTimer: null, pumpTimer: null, stopped: false, unsubscribes: [],
      retryMin: options.retryMinMs || 1000, retryMax: options.retryMaxMs || 60000,
      backoff: options.retryMinMs || 1000, idlePoll: Math.max(500, options.flushIntervalMs || 1000),
      lastOkAt: null, pumping: false, statusLine: 'sync: starting',
      failing: false, failCount: 0, lastWarnAt: 0
    }

    // Outage transitions, not per-retry spam: the first failure, then at most one line
    // every WARN_REPEAT_MS while it persists, then a recovery line. A boat that can
    // never reach its endpoint used to produce no log output at all.
    const noteFailure = (res) => {
      state.failCount++
      const now = Date.now()
      if (state.failing && now - state.lastWarnAt < WARN_REPEAT_MS) return
      state.failing = true
      state.lastWarnAt = now
      const why = res && res.status ? `HTTP ${res.status}` : `unreachable${res && res.error ? ` (${res.error})` : ''}`
      warn(`cannot write to ${cfg.influxUrl} — ${why}; ${state.failCount} failed attempt(s), telemetry is buffering on disk`)
    }
    const noteSuccess = () => {
      if (state.failing) warn(`recovered — writing to ${cfg.influxUrl} again after ${state.failCount} failed attempt(s)`)
      state.failing = false
      state.failCount = 0
      state.configError = null
    }

    // A wrong bucket or token rejects every batch identically, so this is a standing
    // condition rather than an outage: name the exact setting to fix, once, and keep the
    // reason on the status line until it clears.
    const noteConfigError = (res) => {
      state.failCount++
      const notFound = res.status === 404
      state.configError = notFound
        ? `bucket "${cfg.bucket}" not found`
        : `write token rejected (HTTP ${res.status})`
      const now = Date.now()
      if (state.failing && now - state.lastWarnAt < WARN_REPEAT_MS) return
      state.failing = true
      state.lastWarnAt = now
      warn(`sync HELD — ${state.configError}. ` +
        (notFound
          ? 'Set "Data bucket" in the plugin config to the bucket your account actually uses — newer accounts use a UUID. '
          : 'Check the write token, and that it is valid for this bucket. ') +
        'Telemetry is kept on disk (nothing quarantined) and will send itself once this is corrected.')
    }

    const handleDelta = (delta) => {
      try {
        const lines = deltaToLines(delta, { context: selfContext })
        if (lines.length) state.batch.push(...lines)
        if (state.batch.length >= state.batchSize) flush()
      } catch (e) { log('delta error: ' + e.message) }
    }

    const flush = () => {
      if (state.stopped || !state.batch.length) return
      const lines = state.batch
      state.batch = []
      spool.append(lines).then(() => pump()).catch((e) => {
        log('spool append failed: ' + e.message)
        state.batch.unshift(...lines)
      })
    }

    async function pump () {
      if (state.stopped || state.pumping) return
      state.pumping = true
      try {
        const files = await spool.pending()
        for (const file of files) {
          if (state.stopped) break
          let body
          try { body = await fs.promises.readFile(file, 'utf8') } catch { continue }
          if (!body.trim()) { await spool.remove(file); continue }
          const res = await writeLines(cfg, body)
          if (res.ok) {
            await spool.remove(file); state.lastOkAt = new Date(); state.backoff = state.retryMin
            noteSuccess()
          } else if (res.configError) {
            // The settings are wrong, not this batch — every batch would be rejected the
            // same way. Quarantining here would pour the entire telemetry stream into
            // spool/dead/ while the plugin looked busy. Hold everything on disk, say so
            // once, and keep retrying slowly so a corrected bucket or token recovers
            // without a restart.
            noteConfigError(res)
            state.pumping = false; scheduleRetry(res); return
          } else if (res.retryable) {
            noteFailure(res)
            state.pumping = false; scheduleRetry(res); return
          } else {
            // Other 4xx: malformed data. Never retried, so if this is not loud the batch
            // is simply gone.
            warn(`batch REJECTED (HTTP ${res.status}) and quarantined to ${state.spool.deadDir} — check the data`)
            await spool.quarantine(file)
          }
        }
      } catch (e) {
        log('pump error: ' + e.message); state.pumping = false; scheduleRetry(); return
      }
      state.pumping = false; scheduleIdle(); refreshStatus()
    }

    function scheduleRetry (res) {
      if (state.stopped) return
      clearTimeout(state.pumpTimer)
      const delay = state.backoff
      state.backoff = Math.min(state.backoff * 2, state.retryMax)
      state.pumpTimer = setTimeout(pump, delay)
      refreshStatus(`${res && res.status ? 'HTTP ' + res.status : 'offline'} — retry ${Math.round(delay / 1000)}s`)
    }
    function scheduleIdle () {
      if (state.stopped) return
      clearTimeout(state.pumpTimer)
      state.pumpTimer = setTimeout(pump, state.idlePoll)
    }
    async function refreshStatus (suffix) {
      try {
        const { count, bytes } = await spool.stats()
        const last = state.lastOkAt ? state.lastOkAt.toISOString() : 'never'
        // A config error is the headline — it needs the owner, not just time.
        const head = state.configError
          ? `sync: HELD — ${state.configError}; fix the plugin config`
          : `sync: buffered ${count}f/${Math.round(bytes / 1024)}KB; last ok ${last}`
        state.statusLine = state.configError
          ? `${head}; ${count}f/${Math.round(bytes / 1024)}KB held on disk`
          : `${head}${suffix ? '; ' + suffix : ''}`
      } catch {}
    }

    spool.init().then(() => {
      state.flushTimer = setInterval(flush, options.flushIntervalMs || 1000)
      subscribe(handleDelta)
      pump()
      log(`started; buffer dir ${spoolDir}; context ${selfContext}`)
    }).catch((e) => log('init failed: ' + e.message))

    function subscribe (onDelta) {
      const sub = { context: 'vessels.self', subscribe: [{ path: '*', period: options.subscribePeriodMs || 1000 }] }
      if (app.subscriptionmanager && app.subscriptionmanager.subscribe) {
        app.subscriptionmanager.subscribe(sub, state.unsubscribes, (err) => log('subscription error: ' + err), onDelta)
      } else if (app.signalk && app.signalk.on) {
        const h = (d) => { if (!d.context || d.context === selfContext) onDelta(d) }
        app.signalk.on('delta', h)
        state.unsubscribes.push(() => app.signalk.removeListener('delta', h))
      } else {
        log('no subscription mechanism available')
      }
    }
  }

  function stop () {
    if (!state) return
    state.stopped = true
    clearInterval(state.flushTimer)
    clearTimeout(state.pumpTimer)
    for (const u of (state.unsubscribes || [])) { try { u() } catch {} }
    if (state.batch && state.batch.length) {
      try {
        const name = `${Date.now().toString().padStart(15, '0')}-final.lp`
        fs.writeFileSync(path.join(state.spool.dir, name), state.batch.join('\n') + '\n')
        state.batch = []
      } catch (e) { /* best effort */ }
    }
  }

  function status () { return state ? state.statusLine : 'sync: off' }

  // Spool depth, so best-effort work (the backfill) can stand down while live telemetry
  // is behind. Live data is the one thing that must not be starved by a bulk upload.
  async function pending () {
    if (!state || !state.spool) return { count: 0, bytes: 0 }
    try { return await state.spool.stats() } catch { return { count: 0, bytes: 0 } }
  }

  return { start, stop, status, pending }
}

module.exports = { createSync }
