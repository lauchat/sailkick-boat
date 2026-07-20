'use strict'

const path = require('path')
const http = require('http')
const net = require('net')
const { getResource, clearStore } = require('./cache')
const { createManifest } = require('./manifest')
const { createSeeder } = require('./seed')
const { countBboxTiles, bboxTiles } = require('./tiles')

// Caching proxy module. The standalone server (origin root, `proxyPort`) is what
// the browser points at. It routes by path:
//   - localPaths (default /signalk) -> LOCAL SignalK (live telemetry, no cache),
//     including the WebSocket stream (transparent upgrade relay);
//   - everything else -> mirror the sailkick host, GET cached (offline-first),
//     non-GET live pass-through.
// This makes the app (served from the mirror, connecting same-origin to SignalK)
// get its live data from the boat's local SignalK and its charts/weather cached.
// Also exposes the auth'd /plugins/sailkick-boat/p/* router handlers.

function createProxy (app, options) {
  const log = (m) => (app.debug ? app.debug('[proxy] ' + m) : console.log('[sailkick-boat:proxy]', m))
  let cfg = null
  let server = null
  let manifest = null
  let seeder = null
  // Shared upstream circuit breaker: once a fetch fails offline, uncached requests
  // fast-fail for cooldownMs instead of each hanging on the fetch timeout (which
  // would starve the browser's ~6-connection pool and block cached tiles too).
  const health = { downUntil: 0, cooldownMs: 15000 }

  function start () {
    if (!options.sailkickUrl) { log('not started — no sailkickUrl configured'); return }
    const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
    cfg = {
      upstream: options.sailkickUrl.replace(/\/+$/, ''),
      storeDir: options.storeDir || path.join(dataDir, 'store'),
      timeoutMs: options.requestTimeoutMs || 20000,
      localSignalk: (options.localSignalkUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      localPaths: (options.localPaths && options.localPaths.length) ? options.localPaths : ['/signalk'],
      telemetryPath: options.telemetryPath || '/ws/telemetry',
      history: options.history || null,
      openAccess: options.openAccess !== false
    }
    log(`mirroring ${cfg.upstream}; local SignalK ${cfg.localSignalk}; store ${cfg.storeDir}`)

    // Cache-manifest poller: auto-refresh a dataset lazily when the cloud
    // announces a new bake. Tiles are otherwise pinned (no time-based expiry).
    if (!options.manifest || options.manifest.enabled !== false) {
      try {
        manifest = createManifest(app, {
          upstream: cfg.upstream,
          storeDir: cfg.storeDir,
          manifestPath: options.manifest && options.manifest.path,
          pollIntervalSec: options.manifest && options.manifest.pollIntervalSec,
          timeoutMs: cfg.timeoutMs
        })
        manifest.start()
      } catch (e) { log('manifest poller start failed: ' + e.message); manifest = null }
    }

    // Global offline base seeder (coastline + seabed). Fire-and-forget; self-throttles
    // offline via the shared `health` breaker.
    if (!options.seed || options.seed.enabled !== false) {
      try {
        seeder = createSeeder(app, {
          upstream: cfg.upstream,
          storeDir: cfg.storeDir,
          timeoutMs: cfg.timeoutMs,
          health,
          manifest,
          coastlineMaxZoom: options.seed && options.seed.coastlineMaxZoom,
          seabedMaxZoom: options.seed && options.seed.seabedMaxZoom,
          concurrency: options.seed && options.seed.concurrency
        })
        seeder.start()
      } catch (e) { log('seeder start failed: ' + e.message); seeder = null }
    }

    const port = options.proxyPort == null ? 8080 : Number(options.proxyPort)
    if (port > 0) {
      server = http.createServer(serveMirror)
      server.on('upgrade', relayUpgrade) // WebSocket stream -> local SignalK
      server.on('error', (e) => log('mirror server error: ' + e.message))
      server.listen(port, () => log(`mirror on :${port} (local:${cfg.localPaths.join(',')} -> ${cfg.localSignalk}; else -> ${cfg.upstream})`))
      cfg.port = port
    }
  }

  function stop () {
    try { if (seeder) seeder.stop() } catch {}
    seeder = null
    try { if (manifest) manifest.stop() } catch {}
    manifest = null
    if (server) {
      try { if (server.closeAllConnections) server.closeAllConnections() } catch {}
      try { server.close() } catch {}
      server = null
    }
    cfg = null
  }
  function status () {
    if (!cfg) return 'proxy: off'
    const m = manifest ? '; ' + manifest.status() : ''
    const s = seeder ? '; ' + seeder.status() : ''
    return `proxy: mirror ${cfg.upstream}${cfg.port ? ' :' + cfg.port : ''}; live -> ${cfg.localSignalk}${m}${s}`
  }

  const isLocal = (p) => cfg.localPaths.some((lp) => p === lp || p.startsWith(lp + '/') || p.startsWith(lp + '?'))

  async function serveMirror (req, res) {
    if (!cfg) { res.statusCode = 503; res.end('proxy disabled'); return }
    // Local history endpoints, served from the boat's InfluxDB (offline-first, full
    // local dataset). When history isn't configured they fall through to the mirror,
    // so an online boat still gets history from the cloud — never worse than today.
    if (req.method === 'GET' && cfg.history && cfg.history.available()) {
      const pathname = req.url.split('?')[0]
      if (pathname === '/api/history/series') return cfg.history.handleSeries(req, res)
      if (pathname === '/api/history/track') return cfg.history.handleTrack(req, res)
    }
    // /api/config drives the app's login gate + Trends toggle. On the single-tenant
    // boat we serve it with auth turned off (no cloud login over the offline HTTP
    // mirror) and history forced on when we serve it locally. All other config passes
    // through untouched.
    if (req.method === 'GET' && cfg.openAccess && req.url.split('?')[0] === '/api/config') {
      return serveConfig(req, res)
    }
    if (isLocal(req.url)) { return passThrough(req, res, cfg.localSignalk + req.url) } // live SignalK, no cache
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const { buffer, contentType, cacheState } = await getResource({
          storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath: req.url, timeoutMs: cfg.timeoutMs,
          invalidatedAt: manifest ? manifest.invalidatedAtFor(req.url) : 0,
          networkFirst: req.url.startsWith('/api/'), // live data (AIS, weather): fresh online, cache-fallback offline
          health
        })
        res.setHeader('Content-Type', contentType)
        res.setHeader('X-Sailkick-Cache', cacheState)
        res.end(req.method === 'HEAD' ? undefined : buffer)
      } else {
        return passThrough(req, res, cfg.upstream + req.url)
      }
    } catch (e) {
      res.statusCode = e.offline ? 504 : (e.status || 502)
      res.end(e.offline ? 'offline and not cached' : 'proxy error')
    }
  }

  // Serve /api/config with the login gate neutralized for the boat. Reuses the
  // normal cache path (online fetch / offline cached copy), then rewrites just the
  // auth flag (and historyAvailable when we serve history locally) before sending.
  async function serveConfig (req, res) {
    try {
      const { buffer, contentType, cacheState } = await getResource({
        storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath: req.url, timeoutMs: cfg.timeoutMs,
        invalidatedAt: manifest ? manifest.invalidatedAtFor(req.url) : 0, health
      })
      let out = buffer
      let ct = contentType
      try {
        const j = JSON.parse(buffer.toString('utf8'))
        if (j && typeof j === 'object') {
          j.auth = { ...(j.auth || {}), required: false } // single-tenant boat: no cloud login
          if (cfg.history && cfg.history.available()) j.historyAvailable = true // served locally from bandg
          out = Buffer.from(JSON.stringify(j))
          ct = 'application/json'
        }
      } catch { /* not JSON — serve as fetched */ }
      res.setHeader('Content-Type', ct)
      res.setHeader('X-Sailkick-Cache', cacheState)
      res.end(req.method === 'HEAD' ? undefined : out)
    } catch (e) {
      res.statusCode = e.offline ? 504 : (e.status || 502)
      res.end(e.offline ? 'offline and not cached' : 'proxy error')
    }
  }

  // transparent HTTP relay (no cache) — forwards method/body + key headers
  async function passThrough (req, res, target) {
    const chunks = []
    if (req.method !== 'GET' && req.method !== 'HEAD') { for await (const c of req) chunks.push(c) }
    const fwd = {}
    for (const h of ['content-type', 'authorization', 'cookie', 'accept', 'accept-language', 'user-agent']) {
      if (req.headers[h]) fwd[h] = req.headers[h]
    }
    let r
    try {
      r = await fetch(target, { method: req.method, headers: fwd, body: chunks.length ? Buffer.concat(chunks) : undefined })
    } catch (e) { res.statusCode = 502; res.end('upstream unreachable'); return }
    res.statusCode = r.status
    r.headers.forEach((v, k) => {
      const kl = k.toLowerCase()
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(kl)) {
        try { res.setHeader(k, v) } catch {}
      }
    })
    const buf = Buffer.from(await r.arrayBuffer())
    res.end(req.method === 'HEAD' ? undefined : buf)
  }

  // WebSocket (or any HTTP upgrade) on a local path -> transparent TCP relay to
  // the local SignalK server (so the SignalK live stream works through :8080).
  function relayUpgrade (req, clientSocket, head) {
    if (!cfg) { clientSocket.destroy(); return }
    // /ws/telemetry -> the local telemetry provider (served from local SignalK)
    if (options.telemetryUpgrade && req.url.startsWith(cfg.telemetryPath)) {
      options.telemetryUpgrade(req, clientSocket, head); return
    }
    if (!isLocal(req.url)) { clientSocket.destroy(); return }
    let u
    try { u = new URL(cfg.localSignalk) } catch { clientSocket.destroy(); return }
    const upstream = net.connect(Number(u.port || 80), u.hostname, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      raw += '\r\n'
      upstream.write(raw)
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    // tear down both sides together so a disconnect never leaks a socket
    const kill = () => { upstream.destroy(); clientSocket.destroy() }
    upstream.on('error', kill); upstream.on('close', kill)
    clientSocket.on('error', kill); clientSocket.on('close', kill)
  }

  // --- auth'd plugin router handlers (mounted at /plugins/sailkick-boat) ---
  async function handleGet (req, res) {
    if (!cfg) { res.status(503).send('proxy disabled'); return }
    const rest = req.params[0] || ''
    const qi = req.originalUrl.indexOf('?')
    const qs = qi >= 0 ? req.originalUrl.slice(qi) : ''
    const reqPath = '/' + rest + qs
    try {
      const { buffer, contentType, cacheState } = await getResource({
        storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath, timeoutMs: cfg.timeoutMs,
        invalidatedAt: manifest ? manifest.invalidatedAtFor(reqPath) : 0,
        networkFirst: reqPath.startsWith('/api/'), health
      })
      res.set('Content-Type', contentType)
      res.set('X-Sailkick-Cache', cacheState)
      res.send(buffer)
    } catch (e) {
      if (e.offline) res.status(504).send('offline and not cached')
      else res.status(e.status || 502).send('upstream error')
    }
  }

  // POST /plugins/sailkick-boat/cache/clear — manual force-refresh. Query:
  //   ?prefix=tiles/osm-standard   delete one tileset subtree
  //   ?keep=tiles,terrain          delete everything except these (default)
  async function handleClear (req, res) {
    if (!cfg) { res.status(503).send('proxy disabled'); return }
    const prefix = (req.query && req.query.prefix) ? String(req.query.prefix) : ''
    const keep = (req.query && req.query.keep != null)
      ? String(req.query.keep).split(',').map((s) => s.trim()).filter(Boolean)
      : ['tiles', 'terrain']
    try {
      const r = await clearStore({ storeDir: cfg.storeDir, keep, prefix })
      res.json({ ok: true, ...r })
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message })
    }
  }

  // Warm a list of paths into the cache, bounded-concurrency, reusing the circuit
  // breaker (so it fast-fails/goes quiet offline). 404s count as `empty` (negative-
  // cached), not failures. Returns { cached, empty, failed }.
  async function warmMany (paths, concurrency = 6) {
    const arr = Array.isArray(paths) ? paths : [...paths]
    let cached = 0; let empty = 0; let failed = 0; let i = 0
    const worker = async () => {
      while (i < arr.length) {
        const p = arr[i++]
        const reqPath = p.startsWith('/') ? p : '/' + p
        try {
          await getResource({ storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath, timeoutMs: cfg.timeoutMs, health, invalidatedAt: manifest ? manifest.invalidatedAtFor(reqPath) : 0 })
          cached++
        } catch (e) { if (e.status === 404) empty++; else failed++ }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
    return { cached, empty, failed }
  }

  const readBody = (req) => new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => resolve(raw))
  })

  function handlePrefetch (req, res) {
    if (!cfg) { res.status(503).send('proxy disabled'); return }
    readBody(req).then(async (raw) => {
      let paths = []
      try { paths = JSON.parse(raw).paths || [] } catch { paths = raw.split(/\s+/).filter(Boolean) }
      const r = await warmMany(paths)
      res.json({ requested: paths.length, ...r })
    })
  }

  // POST /plugins/sailkick-boat/prefetch/region — warm a bbox×zoom×layers rectangle
  // for offline passage coverage. Estimates first and refuses > cap unless force.
  function handlePrefetchRegion (req, res) {
    if (!cfg) { res.status(503).send('proxy disabled'); return }
    const clampInt = (v, def, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def }
    readBody(req).then(async (raw) => {
      let body = {}
      try { body = JSON.parse(raw) } catch { res.status(400).json({ ok: false, message: 'invalid JSON body' }); return }
      const bbox = body.bbox
      if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => Number.isFinite(n))) {
        res.status(400).json({ ok: false, message: 'bbox [w,s,e,n] (numbers) required' }); return
      }
      const minZoom = clampInt(body.minZoom, 0, 0, 20)
      const maxZoom = Math.max(minZoom, clampInt(body.maxZoom, 15, 0, 20))
      const layers = (Array.isArray(body.layers) && body.layers.length) ? body.layers : ['osm-standard', 'bathy', 'seamap', 'coastline']
      const CAP = 50000
      const estimate = countBboxTiles(bbox, minZoom, maxZoom) * layers.length
      if (estimate > CAP && !body.force) {
        res.json({ ok: true, capped: true, estimate, cap: CAP, message: `~${estimate} tiles exceeds ${CAP}; narrow bbox/zoom or pass force:true` })
        return
      }
      const ext = (layer) => (layer === 'coastline' ? 'pbf' : 'png')
      const paths = []
      for (const layer of layers) {
        for (const { z, x, y } of bboxTiles(bbox, minZoom, maxZoom)) paths.push(`/tiles/${layer}/${z}/${x}/${y}.${ext(layer)}`)
      }
      const r = await warmMany(paths, body.concurrency || 6)
      res.json({ ok: true, requested: paths.length, ...r })
    })
  }

  return { start, stop, status, handleGet, handlePrefetch, handlePrefetchRegion, handleClear, _serveMirror: serveMirror, _serveConfig: serveConfig, _manifest: () => manifest, _seeder: () => seeder }
}

module.exports = { createProxy }
