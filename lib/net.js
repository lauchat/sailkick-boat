'use strict'

// The one outbound HTTP client for everything that talks to the cloud.
//
// WHY NOT fetch()
//
// Twice in one afternoon this boat's Signal K process stopped being able to open ANY
// outbound HTTPS connection: zero sockets to :443, while live connections to the
// Starlink dish and the local database stayed up, file descriptors at 50 of 524288, and
// a second node process in the SAME container reached the same host in 979 ms. It never
// recovered — 33 minutes the second time. Restarting bought about twenty minutes.
//
// Starlink is behind CGNAT, which drops an idle NAT mapping WITHOUT sending an RST. The
// pooled keep-alive socket then looks alive to the client and is dead on the wire.
// fetch() (undici) keeps such sockets, and a plugin has no supported way to reset that
// pool: `undici` is not requirable on the boat (Node bundles it internally),
// `Connection: close` is a forbidden header that fetch strips, and reaching for the
// global-dispatcher symbol is version-specific guesswork.
//
// Core http/https gives what is actually needed:
//   - an agent we own, so a poisoned pool can be thrown away (resetTransport)
//   - a short keep-alive, so an idle socket is dropped by US before CGNAT drops it
//   - the REAL error code. fetch reports every transport failure as the uniformly
//     useless string "fetch failed" and hides the reason in e.cause, so a wedged process
//     and a boat genuinely at sea produced identical logs. Here a caller sees
//     ECONNRESET / ETIMEDOUT / ENOTFOUND / ECONNREFUSED directly.
//
// ONE pool for the whole plugin, so one reset clears every subsystem at once — during
// the incident sync, the mirror, the manifest poller and the contract check were all
// wedged together, because they share the process, not because they share code.
//
// The response shape mirrors the parts of fetch() the callers actually used, so the call
// sites read the same: { ok, status, headers.get(), headers.forEach(), headers
// .getSetCookie(), buffer, text(), json() }. Transport failures THROW, as fetch does —
// with `.code` set, which fetch never gave us.
//
// TWO THINGS fetch() DID FOR FREE that core http does NOT, both of which have to be done
// here or the bytes are silently wrong:
//
//   1. CONTENT-ENCODING. The upstream serves terrain tiles pre-compressed and sets
//      Content-Encoding: gzip whether or not it was asked to. fetch decompressed
//      transparently; core http hands back the gzip stream. The mirror cached those bytes
//      as terrain, and Cesium read the gzip header as a vertex count: "Invalid typed array
//      length: 11239580910". Responses are decoded here, and the encoding header is
//      dropped from the exposed set, exactly as fetch does — the body is no longer encoded,
//      so advertising that it is would be a lie the cache then stores.
//
//   2. COMPLETENESS. fetch rejects a body shorter than its Content-Length. Core http emits
//      'end' regardless and leaves `res.complete` false, so a connection dropped mid-body
//      would look like a clean short response — and tiles are PINNED once written, so a
//      truncated one would be served for ever. Checked explicitly.

const http = require('http')
const zlib = require('zlib')
const https = require('https')
const { URL } = require('url')

// Short keep-alive: long enough that a steady stream reuses a socket, short enough that
// an idle one is closed by us well before a CGNAT mapping expires.
const AGENT_OPTS = { keepAlive: true, keepAliveMsecs: 5000, timeout: 15000, maxSockets: 8 }
const MAX_BODY_BYTES = 64 * 1024 * 1024 // Cesium.js is ~6 MB; this is a sanity ceiling

let agents = null
let generation = 0

function pool () {
  if (!agents) agents = { http: new http.Agent(AGENT_OPTS), https: new https.Agent(AGENT_OPTS) }
  return agents
}

// Throw the pools away. The next request builds fresh sockets — the only thing that
// recovers a pool whose sockets are dead but look open. destroy() closes idle sockets
// only; anything in flight finishes normally.
function resetTransport () {
  if (agents) {
    try { agents.http.destroy() } catch {}
    try { agents.https.destroy() } catch {}
  }
  agents = null
  return ++generation
}

// Undo Content-Encoding, as fetch does. Anything unrecognised is passed through
// untouched rather than guessed at.
function decode (buf, encoding, cb) {
  const enc = String(encoding || '').trim().toLowerCase()
  if (!enc || enc === 'identity' || buf.length === 0) return cb(null, buf)
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzip(buf, cb)
  if (enc === 'deflate') return zlib.inflate(buf, (e, out) => (e ? zlib.inflateRaw(buf, cb) : cb(null, out)))
  if (enc === 'br') return zlib.brotliDecompress(buf, cb)
  cb(null, buf)
}

function headersView (raw) {
  const lower = {}
  for (const [k, v] of Object.entries(raw || {})) lower[k.toLowerCase()] = v
  return {
    get (name) {
      const v = lower[String(name).toLowerCase()]
      return v == null ? null : (Array.isArray(v) ? v.join(', ') : String(v))
    },
    forEach (fn) {
      for (const [k, v] of Object.entries(lower)) fn(Array.isArray(v) ? v.join(', ') : String(v), k)
    },
    // Node keeps set-cookie as an array already — the one header that must not be joined.
    getSetCookie () {
      const v = lower['set-cookie']
      return v == null ? [] : (Array.isArray(v) ? v : [String(v)])
    }
  }
}

// fetch-shaped, minus the parts nothing here uses. Throws on transport failure with
// `.code` populated; an HTTP error status resolves normally (check `ok`/`status`).
function request (url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const settled = [] // run when the socket returns to the pool — see the note below
    let u
    try { u = new URL(url) } catch (e) { return reject(Object.assign(new Error(`bad url: ${url}`), { code: 'ERR_INVALID_URL' })) }
    const lib = u.protocol === 'https:' ? https : http
    const agent = u.protocol === 'https:' ? pool().https : pool().http

    const hdrs = { 'Accept-Encoding': 'gzip, deflate, br', ...headers }
    if (body != null && hdrs['Content-Length'] == null && hdrs['content-length'] == null) {
      hdrs['Content-Length'] = Buffer.byteLength(body)
    }

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      agent,
      headers: hdrs
    }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY_BYTES) { req.destroy(Object.assign(new Error('response too large'), { code: 'EMSGSIZE' })); return }
        chunks.push(c)
      })
      res.on('error', (e) => { settled.forEach((f) => f()); reject(Object.assign(e, { code: e.code || 'ERR_STREAM' })) })
      res.on('end', () => {
        settled.forEach((f) => f())
        // A body cut short must never be mistaken for a short body — see note (2) above.
        if (res.complete === false) {
          return reject(Object.assign(new Error('response truncated'), { code: 'ECONNRESET' }))
        }
        const raw = Buffer.concat(chunks)
        decode(raw, res.headers['content-encoding'], (err, buffer) => {
          if (err) return reject(Object.assign(err, { code: err.code || 'ERR_CONTENT_DECODING' }))
          // Drop the encoding header: the body is decoded now, and a cache that stored it
          // would replay a false claim to every future reader.
          const headers = { ...res.headers }
          delete headers['content-encoding']
          delete headers['content-length'] // no longer describes the body we return
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: headersView(headers),
            buffer,
            text: async () => buffer.toString('utf8'),
            json: async () => JSON.parse(buffer.toString('utf8')),
            arrayBuffer: async () => buffer
          })
        })
      })
    })

    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })))
    }
    // An IDLE pooled socket must never be the reason the host process cannot exit — Signal
    // K has to be able to shut down and a test runner has to finish. But an IN-FLIGHT one
    // must hold the loop, or Node exits mid-request and the caller never resolves (which
    // is exactly what a first attempt at this did). So: ref while the request is running,
    // unref once it is back in the pool.
    let sock = null
    const idle = () => { try { if (sock && sock.unref) sock.unref() } catch {} }
    req.on('socket', (s) => { sock = s; try { if (s.ref) s.ref() } catch {} })
    settled.push(idle)
    req.on('error', (e) => { settled.forEach((f) => f()); reject(Object.assign(e, { code: e.code || 'ERR_REQUEST' })) })
    req.end(body == null ? undefined : body)
  })
}

module.exports = { request, resetTransport, _agents: () => agents, _generation: () => generation }
