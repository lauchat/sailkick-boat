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

// The transport (an owned connection pool, real error codes) lives in lib/net.js —
// see the long note there on why fetch() is unusable on a CGNAT satellite link.

const zlib = require('zlib')
const { request, resetTransport } = require('../net')

async function writeLines (cfg, body) {
  const base = cfg.influxUrl.replace(/\/+$/, '')
  const url = `${base}/api/v2/write` +
    `?org=${encodeURIComponent(cfg.org)}` +
    `&bucket=${encodeURIComponent(cfg.bucket)}` +
    '&precision=ns'

  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'))
  let r
  try {
    r = await request(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${cfg.token}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Encoding': 'gzip'
      },
      body: gz,
      timeoutMs: cfg.timeoutMs
    })
  } catch (e) {
    // The REAL code, not fetch's "fetch failed" — see lib/net.js.
    return { ok: false, retryable: true, networkError: true, code: e.code || null, error: e.message }
  }
  const status = r.status

  if (status === 204) return { ok: true, status: 204 }
  if (CONFIG_ERROR_STATUS.has(status)) {
    return { ok: false, configError: true, retryable: false, status, body: await r.text() }
  }
  const retryable = status === 429 || status >= 500
  return { ok: false, retryable, status, body: await r.text() }
}

module.exports = { writeLines, resetTransport }
