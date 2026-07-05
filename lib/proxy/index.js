'use strict'

const path = require('path')
const http = require('http')
const { getResource } = require('./cache')

// Caching proxy module: mirrors ONE upstream (the sailkick host) and caches
// everything it serves. Two entry points:
//   1. A STANDALONE HTTP server at origin root on `proxyPort` (default 8080) —
//      no SignalK auth, and root-relative app URLs (/cesium, /assets) resolve
//      correctly. This is what a browser points at: http://<boat>:<port>/ .
//   2. The plugin's own router at /plugins/sailkick-boat/p/* (behind SignalK
//      auth) — handy for authenticated same-origin use.
// createProxy(app, options) -> { start, stop, status, handleGet, handlePrefetch }

function createProxy (app, options) {
  const log = (m) => (app.debug ? app.debug('[proxy] ' + m) : console.log('[sailkick-boat:proxy]', m))
  let cfg = null
  let server = null

  function start () {
    if (!options.sailkickUrl) { log('not started — no sailkickUrl configured'); return }
    const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
    cfg = {
      upstream: options.sailkickUrl.replace(/\/+$/, ''),
      storeDir: options.storeDir || path.join(dataDir, 'store'),
      timeoutMs: options.requestTimeoutMs || 20000
    }
    log(`mirroring ${cfg.upstream}; store ${cfg.storeDir}`)

    // standalone mirror server at origin root (public, root-relative URLs work)
    const port = options.proxyPort == null ? 8080 : Number(options.proxyPort)
    if (port > 0) {
      server = http.createServer(serveMirror)
      server.on('error', (e) => log('mirror server error: ' + e.message))
      server.listen(port, () => log(`mirror server listening on :${port} -> ${cfg.upstream}`))
      cfg.port = port
    }
  }

  function stop () {
    if (server) { try { server.close() } catch {} server = null }
    cfg = null
  }

  function status () {
    if (!cfg) return 'proxy: off'
    return `proxy: mirroring ${cfg.upstream}${cfg.port ? ' on :' + cfg.port : ''}`
  }

  // Standalone-server handler: transparent mirror of the sailkick host at root.
  // GET/HEAD are cached (offline-first); other methods pass through live (so the
  // online app's writes work) but are not cached.
  async function serveMirror (req, res) {
    if (!cfg) { res.statusCode = 503; res.end('proxy disabled'); return }
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const { buffer, contentType, fromCache } = await getResource({
          storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath: req.url, timeoutMs: cfg.timeoutMs
        })
        res.setHeader('Content-Type', contentType)
        res.setHeader('X-Sailkick-Cache', fromCache ? 'HIT' : 'MISS')
        res.end(req.method === 'HEAD' ? undefined : buffer)
      } else {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const r = await fetch(cfg.upstream + req.url, {
          method: req.method,
          body: chunks.length ? Buffer.concat(chunks) : undefined
        })
        res.statusCode = r.status
        const ct = r.headers.get('content-type')
        if (ct) res.setHeader('Content-Type', ct)
        res.end(Buffer.from(await r.arrayBuffer()))
      }
    } catch (e) {
      res.statusCode = e.offline ? 504 : (e.status || 502)
      res.end(e.offline ? 'offline and not cached' : 'proxy error')
    }
  }

  // --- plugin router handlers (mounted at /plugins/sailkick-boat, auth'd) ---
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
