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
      log('not started — missing influxUrl / bucket / token')
      state = { statusLine: 'sync: not configured', stopped: true }
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
      lastOkAt: null, pumping: false, statusLine: 'sync: starting'
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
          } else if (res.retryable) {
            state.pumping = false; scheduleRetry(res); return
          } else {
            log(`batch rejected (HTTP ${res.status}) — quarantined`); await spool.quarantine(file)
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
        state.statusLine = `sync: buffered ${count}f/${Math.round(bytes / 1024)}KB; last ok ${last}${suffix ? '; ' + suffix : ''}`
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

  return { start, stop, status }
}

module.exports = { createSync }
