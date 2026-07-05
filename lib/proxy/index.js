'use strict'

const path = require('path')
const { getResource } = require('./cache')

// Caching proxy module: mirrors ONE upstream (the sailkick host) and caches
// everything it serves. createProxy(app, options) -> { start, stop, status,
// handleGet, handlePrefetch }. The plugin wires handleGet/handlePrefetch to its
// router; they read the live config so enable/disable works at request time.

function createProxy (app, options) {
  const log = (m) => (app.debug ? app.debug('[proxy] ' + m) : console.log('[sailkick-boat:proxy]', m))
  let cfg = null

  function start () {
    if (!options.sailkickUrl) {
      log('not started — no sailkickUrl configured')
      return
    }
    const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
    cfg = {
      upstream: options.sailkickUrl.replace(/\/+$/, ''),
      storeDir: options.storeDir || path.join(dataDir, 'store'),
      timeoutMs: options.requestTimeoutMs || 20000
    }
    log(`started; mirroring ${cfg.upstream}; store ${cfg.storeDir}`)
  }

  function stop () { cfg = null }
  function status () { return cfg ? `proxy: mirroring ${cfg.upstream}` : 'proxy: off' }

  // GET /p/<path...>  -> serve from cache or fetch+cache from the upstream
  async function handleGet (req, res) {
    if (!cfg) { res.status(503).send('proxy disabled'); return }
    const rest = req.params[0] || ''
    const qi = req.originalUrl.indexOf('?')
    const qs = qi >= 0 ? req.originalUrl.slice(qi) : ''
    const reqPath = '/' + rest + qs
    try {
      const { buffer, contentType, fromCache } = await getResource({
        storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath, timeoutMs: cfg.timeoutMs
      })
      res.set('Content-Type', contentType)
      res.set('X-Sailkick-Cache', fromCache ? 'HIT' : 'MISS')
      res.send(buffer)
    } catch (e) {
      if (e.offline) res.status(504).send('offline and not cached')
      else res.status(e.status || 502).send('upstream error')
    }
  }

  // POST /prefetch  body: JSON {"paths":[...]} OR whitespace-separated paths.
  // Warms the cache for those paths (call while online).
  function handlePrefetch (req, res) {
    if (!cfg) { res.status(503).send('proxy disabled'); return }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', async () => {
      let paths = []
      try { paths = JSON.parse(raw).paths || [] } catch { paths = raw.split(/\s+/).filter(Boolean) }
      let cached = 0; let failed = 0
      for (const p of paths) {
        const reqPath = p.startsWith('/') ? p : '/' + p
        try { await getResource({ storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath, timeoutMs: cfg.timeoutMs }); cached++ } catch { failed++ }
      }
      res.json({ requested: paths.length, cached, failed })
    })
  }

  return { start, stop, status, handleGet, handlePrefetch }
}

module.exports = { createProxy }
