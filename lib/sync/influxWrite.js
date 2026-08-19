'use strict'

// POST gzipped line protocol to InfluxDB v2's /api/v2/write.
//
// Return shape:
//   { ok: true, status: 204 }
//   { ok: false, retryable: true,  networkError: true, code, error }  connection failed
//   { ok: false, retryable: true,  status }                            429 / 5xx (transient)
//   { ok: false, configError: true, status, body }                     404 / 401 / 403
//   { ok: false, retryable: false, status, body }                      other 4xx (bad data)
//
// Most 4xx is non-retryable: retrying a malformed batch forever would wedge the queue,
// so the caller quarantines it instead.
//
// 404/401/403 are different in kind and must NOT be quarantined. They say "your settings
// are wrong", not "this batch is bad" — a missing bucket or a bad token rejects EVERY
// batch equally, so quarantining would feed the whole telemetry stream into spool/dead/
// while looking like normal operation. That is not hypothetical: the fleet renamed this
// boat's bucket from `addiction_raw` to a UUID, and a plugin left running through it
// would have shredded every point it collected. The caller holds these on disk instead
// and keeps retrying slowly, so correcting the config recovers on its own.
const CONFIG_ERROR_STATUS = new Set([401, 403, 404])

// WHY CORE http/https AND NOT fetch
//
// Twice in one afternoon the Signal K process stopped being able to open ANY outbound
// HTTPS connection while a second process in the same container reached the same host in
// under a second: zero sockets to :443, live connections to the Starlink dish and the
// local database, no resource exhaustion, and it never recovered — 33 minutes the second
// time. Restarting fixed it for about twenty minutes.
//
// The boat is on Starlink, which is behind CGNAT. An idle NAT mapping is dropped without
// an RST, so a pooled keep-alive socket looks alive to the client and is dead on the
// wire. fetch() (undici) keeps such sockets, and there is no supported way to reset its
// pool from here: `undici` is not requirable on the boat (Node bundles it internally),
// `Connection: close` is a forbidden header that fetch strips, and reaching for the
// global-dispatcher symbol would be version-specific guesswork.
//
// Core https gives what is actually needed: an agent we own, so a poisoned pool can be
// thrown away and rebuilt (resetTransport), and a short keep-alive so a socket is
// discarded before CGNAT drops it rather than after.
//
// It also fixes the diagnostics. fetch reports every transport failure as the useless
// string "fetch failed" and hides the reason in e.cause, which this module used to
// discard — so a wedged process and a boat genuinely at sea produced identical logs, and
// every diagnosis was guesswork around a missing string. Core http surfaces ECONNRESET /
// ETIMEDOUT / EPIPE / ENOTFOUND directly.

const zlib = require('zlib')
const http = require('http')
const https = require('https')
const { URL } = require('url')

// Short keep-alive: long enough that a steady 1/s write stream reuses a socket, short
// enough that an idle one is dropped by US before the NAT drops it silently.
const AGENT_OPTS = { keepAlive: true, keepAliveMsecs: 5000, timeout: 15000, maxSockets: 4 }
let agents = null
let generation = 0

function transport () {
  if (!agents) {
    agents = { http: new http.Agent(AGENT_OPTS), https: new https.Agent(AGENT_OPTS) }
  }
  return agents
}

// Throw the pools away. The next write builds fresh sockets, which is the only thing
// that recovers a connection pool whose sockets are dead but look open. Cheap and safe:
// destroy() only closes idle sockets, and in-flight requests finish on their own.
function resetTransport () {
  if (agents) {
    try { agents.http.destroy() } catch {}
    try { agents.https.destroy() } catch {}
  }
  agents = null
  generation++
  return generation
}

function request (url, gz, cfg) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch (e) { return resolve({ ok: false, retryable: false, error: `bad url: ${e.message}` }) }
    const lib = u.protocol === 'https:' ? https : http
    const agent = u.protocol === 'https:' ? transport().https : transport().http

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'POST',
      agent,
      headers: {
        Authorization: `Token ${cfg.token}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': gz.length
      }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ httpStatus: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', (e) => resolve({ ok: false, retryable: true, networkError: true, code: e.code || null, error: e.message }))
    })

    if (cfg.timeoutMs) {
      req.setTimeout(cfg.timeoutMs, () => {
        req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }))
      })
    }
    req.on('error', (e) => resolve({ ok: false, retryable: true, networkError: true, code: e.code || null, error: e.message }))
    req.end(gz)
  })
}

async function writeLines (cfg, body) {
  const base = cfg.influxUrl.replace(/\/+$/, '')
  const url = `${base}/api/v2/write` +
    `?org=${encodeURIComponent(cfg.org)}` +
    `&bucket=${encodeURIComponent(cfg.bucket)}` +
    '&precision=ns'

  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'))
  const r = await request(url, gz, cfg)
  if (r.ok === false) return r // transport failure, already shaped
  const status = r.httpStatus

  if (status === 204) return { ok: true, status: 204 }
  if (CONFIG_ERROR_STATUS.has(status)) {
    return { ok: false, configError: true, retryable: false, status, body: r.body }
  }
  const retryable = status === 429 || status >= 500
  return { ok: false, retryable, status, body: r.body }
}

module.exports = { writeLines, resetTransport, _agents: () => agents }
