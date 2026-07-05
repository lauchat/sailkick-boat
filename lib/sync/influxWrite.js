'use strict'

// POST gzipped line protocol to InfluxDB v2's /api/v2/write.
//
// Return shape:
//   { ok: true, status: 204 }
//   { ok: false, retryable: true,  networkError: true }   connection failed
//   { ok: false, retryable: true,  status }                429 / 5xx (transient)
//   { ok: false, retryable: false, status, body }          4xx (bad data/auth)
//
// 4xx is non-retryable: retrying a malformed or unauthorized batch forever would
// wedge the queue, so the caller quarantines it instead.

const zlib = require('zlib')

async function writeLines (cfg, body) {
  const base = cfg.influxUrl.replace(/\/+$/, '')
  const url = `${base}/api/v2/write` +
    `?org=${encodeURIComponent(cfg.org)}` +
    `&bucket=${encodeURIComponent(cfg.bucket)}` +
    '&precision=ns'

  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'))

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${cfg.token}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Encoding': 'gzip'
      },
      body: gz,
      signal: cfg.timeoutMs ? AbortSignal.timeout(cfg.timeoutMs) : undefined
    })
  } catch (e) {
    return { ok: false, retryable: true, networkError: true, error: e.message }
  }

  if (res.status === 204) return { ok: true, status: 204 }

  let text = ''
  try { text = await res.text() } catch {}
  const retryable = res.status === 429 || res.status >= 500
  return { ok: false, retryable, status: res.status, body: text }
}

module.exports = { writeLines }
