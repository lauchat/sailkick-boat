'use strict'

const path = require('path')
const http = require('http')
const net = require('net')
const { getResource, clearStore } = require('./cache')
const { createManifest } = require('./manifest')
const { createContractCheck } = require('../telemetry/contract')
const { createSeeder } = require('./seed')
const { countBboxTiles, bboxTiles, boxAround } = require('./tiles')
const { request } = require('../net')

// Caching proxy module. The standalone server (origin root, `proxyPort`) is what
// the browser points at. It routes by path:
//   - localPaths (default /signalk) -> LOCAL SignalK (live telemetry, no cache),
//     including the WebSocket stream (transparent upgrade relay);
//   - everything else -> mirror the sailkick host, GET cached (offline-first),
//     non-GET live pass-through.
// This makes the app (served from the mirror, connecting same-origin to SignalK)
// get its live data from the boat's local SignalK and its charts/weather cached.
// Also exposes the auth'd /plugins/sailkick-boat/p/* router handlers.

// Everything under /api/ is dynamic and network-first — EXCEPT paths whose URL is
// immutable by construction. Velocity tiles embed the forecast run id
// (/api/velocity/tiles/<layer>/<runId>/<z>/<x>/<y>/<hour>.f32, see the app's
// public/engine/velocity-client.js), so a given URL's bytes never change: a new
// forecast run produces new URLs. Treating them as network-first re-downloaded the
// whole wind field on every pan while online, and left nothing usable offline —
// pinning them is what makes wind particles and the storm field work with no uplink.
//
// The velocity *manifest* is deliberately NOT in here: it resolves `run=latest` and
// must stay live, otherwise the boat pins itself to a stale forecast run forever.
const IMMUTABLE_API_PREFIXES = ['/api/velocity/tiles/']
const isImmutableApi = (p) => IMMUTABLE_API_PREFIXES.some((x) => p.startsWith(x))

// HTML entry documents are network-first too, for the opposite reason to tiles: they are
// the ONE file whose URL never changes across deploys. Everything they pull in is
// content-hashed (main-Cm1RhM4y.js, main-BboaeyYc.css), so a fresh index.html
// automatically drags in the new build as ordinary cache misses — but a pinned one keeps
// the boat on whatever version it happened to cache first, forever.
//
// The cache manifest was supposed to handle this by announcing a new `app` id. In
// practice that id is the app's package version, which does not change on every deploy
// (three deploys in one day all reported "0.2.0"), so nothing was ever invalidated.
// Not caching the entry document removes the dependency on that signal entirely.
//
// Costs one ~8 KB request per app load while online. Offline it falls back to the cached
// copy as STALE like any network-first path, so the app still opens with no uplink.
// /health reports the running build and uptime — pinning it freezes the version the UI
// displays, which is its own small version of this bug.
const LIVE_PATHS = new Set(['/health'])
const isEntryDocument = (p) => {
  const path = p.split('?')[0]
  return path === '/' || path.endsWith('/') || path.endsWith('.html') ||
    path.endsWith('.webmanifest') || LIVE_PATHS.has(path)
}
const isNetworkFirst = (p) => isEntryDocument(p) || (p.startsWith('/api/') && !isImmutableApi(p))

// A prefetch must not spend its tile budget on tiles that cannot exist. Layers top out
// at very different zooms — coastline at 13 where osm-standard goes to 19 — so applying
// one "detail level" to all of them wasted 23% of a real 50nm/z15 run on ~55k coastline
// requests that could only 404. Those also counted toward the cap, so a request could be
// refused for tiles that were never there.
//
// The upstream publishes the real limits at /api/assets, so ask rather than hardcode;
// these are only the fallback for when it cannot be reached (offline, or an older host).
const FALLBACK_MAX_ZOOM = { 'osm-standard': 19, seamap: 18, bathy: 16, coastline: 13, 'natural-earth': 7 }

function createProxy (app, options) {
  const log = (m) => (app.debug ? app.debug('[proxy] ' + m) : console.log('[sailkick-boat:proxy]', m))
  let cfg = null
  let server = null
  let manifest = null
  let seeder = null
  let contract = null
  let area = null // "download around the boat" progress
  let stopping = false
  // Shared upstream circuit breaker: once a fetch fails offline, uncached requests
  // fast-fail for cooldownMs instead of each hanging on the fetch timeout (which
  // would starve the browser's ~6-connection pool and block cached tiles too).
  const health = { downUntil: 0, cooldownMs: 15000 }

  function start () {
    if (!options.sailkickUrl) { log('not started — no sailkickUrl configured'); return }
    stopping = false
    const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
    cfg = {
      upstream: options.sailkickUrl.replace(/\/+$/, ''),
      storeDir: options.storeDir || path.join(dataDir, 'store'),
      timeoutMs: options.requestTimeoutMs || 20000,
      localSignalk: (options.localSignalkUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      localPaths: (options.localPaths && options.localPaths.length) ? options.localPaths : ['/signalk'],
      telemetryPath: options.telemetryPath || '/ws/telemetry',
      history: options.history || null,
      aisTargets: options.aisTargets || null,
      profile: options.profile || null,
      boat: options.boat || null, // { perfKey, slug } — patched into /api/config, see serveConfig
      openAccess: options.openAccess !== false
    }
    log(`mirroring ${cfg.upstream}; local SignalK ${cfg.localSignalk}; store ${cfg.storeDir}`)
    if (cfg.boat && cfg.boat.perfKey) log(`boat identity for the app: perfKey=${cfg.boat.perfKey} (performance data cloud at /perf/${cfg.boat.perfKey}/)`)

    // Cache-manifest poller: auto-refresh a dataset lazily when the cloud
    // announces a new bake. Tiles are otherwise pinned (no time-based expiry).
    if (!options.manifest || options.manifest.enabled !== false) {
      try {
        contract = createContractCheck(app, { timeoutMs: cfg.timeoutMs })
        manifest = createManifest(app, {
          upstream: cfg.upstream,
          storeDir: cfg.storeDir,
          contract,
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

    // "Download around the boat" — config-driven region prefetch (fire-and-forget).
    try { startAreaPrefetch() } catch (e) { log('area prefetch start failed: ' + e.message) }

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
    stopping = true
    area = null
    try { if (seeder) seeder.stop() } catch {}
    seeder = null
    try { if (manifest) manifest.stop() } catch {}
    manifest = null
    contract = null
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
    const c = (contract && contract.status()) ? '; ' + contract.status() : ''
    return `proxy: mirror ${cfg.upstream}${cfg.port ? ' :' + cfg.port : ''}; live -> ${cfg.localSignalk}${m}${s}${areaStatus()}${c}`
  }

  // Per-layer max zoom from the upstream asset manifest, cached. Never throws: on any
  // failure the fallback table is used, so a prefetch still runs offline.
  let zoomCache = null
  // Synchronous view, so planning a prefetch never waits on the network. The fallback
  // matches what the upstream publishes today; refreshLayerZooms() replaces it in the
  // background at start, and the region API awaits it for the freshest numbers.
  const zooms = () => zoomCache || FALLBACK_MAX_ZOOM
  async function layerMaxZooms () {
    if (zoomCache) return zoomCache
    const out = { ...FALLBACK_MAX_ZOOM }
    try {
      const r = await request(cfg.upstream + '/api/assets', { timeoutMs: cfg.timeoutMs })
      if (r.ok) {
        const j = await r.json()
        const raster = j && j.tiles && j.tiles.manifest && j.tiles.manifest.maxZoom
        if (raster && typeof raster === 'object') Object.assign(out, raster)
        // coastline is a vector layer and reports its own bounds separately
        if (j && j.coastline && Number.isFinite(j.coastline.maxZoom)) out.coastline = j.coastline.maxZoom
        log(`layer max zooms: ${Object.entries(out).map(([k, v]) => k + '=' + v).join(' ')}`)
      }
    } catch { log('could not read /api/assets — using fallback layer zoom limits') }
    zoomCache = out
    return out
  }

  // COUNT ONLY — arithmetic, no allocation. The cap exists to stop absurd requests, so
  // it has to be checked before anything is enumerated: a global z0-15 box is ~1.4
  // billion tiles per layer, which must never reach an array.
  function planTiles (bbox, minZoom, maxZoom, layers, zooms) {
    const perLayer = {}
    let total = 0
    for (const l of layers) {
      const top = Math.min(maxZoom, zooms[l] == null ? maxZoom : zooms[l])
      const count = top < minZoom ? 0 : countBboxTiles(bbox, minZoom, top)
      perLayer[l] = { top, count }
      total += count
    }
    return { total, perLayer }
  }

  // Enumerate only once the plan is known to be within the cap. A generator, so even a
  // large accepted plan is streamed rather than held twice.
  function * enumerateTiles (bbox, minZoom, perLayer) {
    const ext = (l) => (l === 'coastline' ? 'pbf' : 'png')
    for (const [l, { top }] of Object.entries(perLayer)) {
      if (top < minZoom) continue
      for (const { z, x, y } of bboxTiles(bbox, minZoom, top)) yield `/tiles/${l}/${z}/${x}/${y}.${ext(l)}`
    }
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
    // AIS targets, from the boat's own SignalK. The cloud's /api/ais is gated behind a
    // boat session the mirror can never hold (it forwards no cookies), and its poller
    // reads a LAN address it cannot reach once the boat is on a mobile link — so
    // proxying it returns 401 whatever we do. Served locally it also works with no
    // uplink at all, which is when other vessels on the chart matter most.
    if (req.method === 'GET' && cfg.aisTargets && cfg.aisTargets.available() &&
        req.url.split('?')[0] === '/api/ais') {
      return cfg.aisTargets.handleAis(req, res)
    }
    // Routes / polars / settings, from a file on the boat. The cloud's /api/profile is
    // requireBoat-gated and the mirror can hold no such session — the GET cache path
    // forwards no headers, and the browser has no cloud cookie for this LAN origin
    // anyway — so proxying it returned 401 on every call and 504 offline. All methods,
    // since the app saves and deletes routes here too.
    if (cfg.profile && cfg.profile.available() && cfg.profile.handles(req.url)) {
      return cfg.profile.handle(req, res)
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
          // An immutable URL needs no invalidation: a bake announcement can't change
          // bytes that are keyed by run id, so don't let an app rebuild churn them.
          invalidatedAt: isImmutableApi(req.url) ? 0 : (manifest ? manifest.invalidatedAtFor(req.url) : 0),
          networkFirst: isNetworkFirst(req.url), // live data (AIS, weather, lightning): fresh online, cache-fallback offline
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
          if (cfg.history && cfg.history.available()) j.historyAvailable = true // served locally (InfluxDB or ring)
          // The cloud fills `boat` only for a logged-in session, and the mirror forwards no
          // cookie — so it always arrived as null and the app had no identity. Harmless for
          // most of the UI, but public/engine/polar-cloud.js keys the performance data cloud
          // on boat.perfKey and throws 'no boat identity' without it, so the polar cloud was
          // simply absent on the boat while the bake sat cached and reachable.
          //
          // perfKey is not guessed: server/auth/registry.js defaults `bucket` and `perfKey`
          // from the same identity, so the bucket minus its _raw suffix IS the perf key —
          // for UUID accounts and for grandfathered slug ones alike.
          if (cfg.boat && cfg.boat.perfKey) {
            j.boat = {
              ...(j.boat || {}),
              perfKey: cfg.boat.perfKey,
              slug: cfg.boat.slug || cfg.boat.perfKey,
              name: (j.boat && j.boat.name) || cfg.boat.slug || cfg.boat.perfKey,
              // NEVER readOnly: that flag exists for public visitor sessions, and it hides
              // the editing affordances. The owner at the chart table has full control.
              readOnly: false
            }
          }
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
      r = await request(target, { method: req.method, headers: fwd, body: chunks.length ? Buffer.concat(chunks) : undefined, timeoutMs: cfg.timeoutMs })
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
        invalidatedAt: isImmutableApi(reqPath) ? 0 : (manifest ? manifest.invalidatedAtFor(reqPath) : 0),
        networkFirst: isNetworkFirst(reqPath), health
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
      : ['tiles', 'terrain', 'history'] // 'history' = the persistent ring log lives under storeDir
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
  async function warmMany (paths, { concurrency = 6, onProgress } = {}) {
    const arr = Array.isArray(paths) ? paths : [...paths]
    let cached = 0; let empty = 0; let failed = 0; let i = 0
    const worker = async () => {
      while (i < arr.length && !stopping) {
        const p = arr[i++]
        const reqPath = p.startsWith('/') ? p : '/' + p
        try {
          await getResource({ storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath, timeoutMs: cfg.timeoutMs, health, invalidatedAt: manifest ? manifest.invalidatedAtFor(reqPath) : 0 })
          cached++
        } catch (e) { if (e.status === 404) empty++; else failed++ }
        if (onProgress) onProgress()
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
      if (!zoomCache) layerMaxZooms().catch(() => {}) // refresh for next time; never block a request
      const { total, perLayer } = planTiles(bbox, minZoom, maxZoom, layers, zooms())
      if (total > CAP && !body.force) {
        res.json({ ok: true, capped: true, estimate: total, cap: CAP, perLayer, message: `~${total} tiles exceeds ${CAP}; narrow bbox/zoom or pass force:true` })
        return
      }
      const paths = [...enumerateTiles(bbox, minZoom, perLayer)]
      const r = await warmMany(paths, { concurrency: body.concurrency || 6 })
      res.json({ ok: true, requested: paths.length, perLayer, ...r })
    })
  }

  // --- "download around the boat" (config-driven region prefetch) ---
  function getBoatPos () {
    try {
      const p = app.getSelfPath && app.getSelfPath('navigation.position')
      const v = p && (p.value || p)
      if (v && Number.isFinite(v.latitude) && Number.isFinite(v.longitude)) return v
    } catch {}
    return null
  }

  // Kicks off a background prefetch of a radius around the boat's current position at
  // the chosen detail zoom. Retries for a position fix (from local SignalK) for a
  // while, then gives up. Idempotent (cached tiles are skipped). Returns the warming
  // promise (or null) so tests can await it.
  function startAreaPrefetch (attempt = 0) {
    const pf = options.prefetch || {}
    const radius = Number(pf.radiusNm) || 0
    if (radius <= 0 || stopping) return null
    const maxZoom = Number(pf.detailZoom) || 13
    const minZoom = Math.min(6, maxZoom)
    const layers = (Array.isArray(pf.layers) && pf.layers.length) ? pf.layers : ['osm-standard', 'bathy', 'seamap', 'coastline']
    const pos = getBoatPos()
    if (!pos) {
      if (attempt < 30 && !stopping) { const t = setTimeout(() => startAreaPrefetch(attempt + 1), 10000); if (t.unref) t.unref() } else log('area prefetch: no boat position — skipped')
      return null
    }
    // Learn the real per-layer limits for next time; plan now with what we have. Only
    // probed when a prefetch is actually configured — a boat that never prefetches
    // should not make the request at all.
    if (!zoomCache) layerMaxZooms().catch(() => {})

    const bbox = boxAround(pos.latitude, pos.longitude, radius)
    const CAP = 150000
    const { total, perLayer } = planTiles(bbox, minZoom, maxZoom, layers, zooms())
    const clamped = Object.entries(perLayer).filter(([, v]) => v.top < maxZoom)
    if (clamped.length) log(`area prefetch: ${clamped.map(([l, v]) => `${l} capped at z${v.top}`).join(', ')} (upstream limit — those tiles do not exist)`)
    if (total > CAP) { area = { capped: true, total, radius, maxZoom }; log(`area prefetch: ~${total} tiles too large — reduce radius/detail`); return null }
    const paths = [...enumerateTiles(bbox, minZoom, perLayer)]
    // Hold our OWN reference and mutate that, never the `area` slot. A prefetch of tens
    // of thousands of tiles outlives a plugin disable by minutes, and stop() sets
    // area = null — so settling handlers that touched `area` threw
    // "Cannot set properties of null (setting 'running')" on every disable/enable. The
    // same reference also protects against a restart having installed a NEWER prefetch:
    // the old run must not report its progress into the new one's counters.
    const run = { done: 0, total: paths.length, running: true, radius, maxZoom, perLayer }
    area = run
    log(`area prefetch: ${radius}nm around ${pos.latitude.toFixed(2)},${pos.longitude.toFixed(2)} to z${maxZoom} — ${paths.length} tiles`)
    run.promise = warmMany(paths, { concurrency: pf.concurrency || 4, onProgress: () => { run.done++ } })
      .then((r) => { run.running = false; run.result = r; log(`area prefetch done: ${r.cached} cached, ${r.empty} empty, ${r.failed} failed`); return r })
      .catch((e) => { run.running = false; log('area prefetch error: ' + e.message) })
    return run.promise
  }

  function areaStatus () {
    if (!area) return ''
    if (area.capped) return `; area: too large (~${area.total}) — reduce radius/detail`
    return `; area(${area.radius}nm z${area.maxZoom}): ${area.done}/${area.total}${area.running ? '' : ' done'}`
  }

  return { start, stop, status, handleGet, handlePrefetch, handlePrefetchRegion, handleClear, _serveMirror: serveMirror, _serveConfig: serveConfig, _manifest: () => manifest, _seeder: () => seeder, _startAreaPrefetch: startAreaPrefetch, _area: () => area }
}

module.exports = { createProxy, isNetworkFirst, isImmutableApi, isEntryDocument }
