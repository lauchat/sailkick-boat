'use strict'

const path = require('path')
const http = require('http')
const net = require('net')
const { getResource } = require('./cache')

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

  function start () {
    if (!options.sailkickUrl) { log('not started — no sailkickUrl configured'); return }
    const dataDir = (app.getDataDirPath && app.getDataDirPath()) || '.'
    cfg = {
      upstream: options.sailkickUrl.replace(/\/+$/, ''),
      storeDir: options.storeDir || path.join(dataDir, 'store'),
      timeoutMs: options.requestTimeoutMs || 20000,
      localSignalk: (options.localSignalkUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      localPaths: (options.localPaths && options.localPaths.length) ? options.localPaths : ['/signalk'],
      telemetryPath: options.telemetryPath || '/ws/telemetry'
    }
    log(`mirroring ${cfg.upstream}; local SignalK ${cfg.localSignalk}; store ${cfg.storeDir}`)

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
    if (server) {
      try { if (server.closeAllConnections) server.closeAllConnections() } catch {}
      try { server.close() } catch {}
      server = null
    }
    cfg = null
  }
  function status () {
    if (!cfg) return 'proxy: off'
    return `proxy: mirror ${cfg.upstream}${cfg.port ? ' :' + cfg.port : ''}; live -> ${cfg.localSignalk}`
  }

  const isLocal = (p) => cfg.localPaths.some((lp) => p === lp || p.startsWith(lp + '/') || p.startsWith(lp + '?'))

  async function serveMirror (req, res) {
    if (!cfg) { res.statusCode = 503; res.end('proxy disabled'); return }
    if (isLocal(req.url)) { return passThrough(req, res, cfg.localSignalk + req.url) } // live SignalK, no cache
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const { buffer, contentType, fromCache } = await getResource({
          storeDir: cfg.storeDir, upstream: cfg.upstream, reqPath: req.url, timeoutMs: cfg.timeoutMs
        })
        res.setHeader('Content-Type', contentType)
        res.setHeader('X-Sailkick-Cache', fromCache ? 'HIT' : 'MISS')
        res.end(req.method === 'HEAD' ? undefined : buffer)
      } else {
        return passThrough(req, res, cfg.upstream + req.url)
      }
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
