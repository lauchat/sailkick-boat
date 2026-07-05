'use strict'

// Caching mirror of a single upstream (the sailkick host). getResource() serves
// a path from the on-disk store if present, else fetches it from the upstream,
// stores it (bytes + content-type sidecar) atomically, and serves it — so any
// resource (tiles, JSON, app assets) is fetched once online then served forever
// offline. The Node/proxy_store equivalent, generalized beyond tiles.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')

// Map a request path (possibly with a query string) to on-disk file paths.
// Path structure is mirrored for inspectability; a query string is folded into
// the filename via a short hash so different query params cache separately.
function storePaths (storeDir, reqPath) {
  const qIdx = reqPath.indexOf('?')
  let p = qIdx >= 0 ? reqPath.slice(0, qIdx) : reqPath
  const q = qIdx >= 0 ? reqPath.slice(qIdx + 1) : ''
  p = p.replace(/^\/+/, '') || 'index'
  let rel = p.replace(/[^a-zA-Z0-9._/-]/g, '_').replace(/\.\.(\/|$)/g, '')
  if (q) rel += '__q_' + crypto.createHash('sha1').update(q).digest('hex').slice(0, 16)
  const file = path.resolve(storeDir, rel)
  // safety: never escape the store dir
  if (!file.startsWith(path.resolve(storeDir) + path.sep)) {
    throw new Error('invalid path')
  }
  return { file, meta: file + '.ct' }
}

// opts: { storeDir, upstream, reqPath, timeoutMs }
// returns { buffer, contentType, fromCache }; throws (err.offline / err.status)
// only when neither cached nor fetchable.
async function getResource (opts) {
  const { storeDir, upstream, reqPath, timeoutMs = 20000 } = opts
  const { file, meta } = storePaths(storeDir, reqPath)

  // 1. serve from disk (works offline)
  try {
    const buffer = await fsp.readFile(file)
    let contentType = 'application/octet-stream'
    try { contentType = (await fsp.readFile(meta, 'utf8')).trim() || contentType } catch {}
    return { buffer, contentType, fromCache: true }
  } catch { /* miss */ }

  // 2. fetch upstream
  const url = upstream.replace(/\/+$/, '') + reqPath
  let resp
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const err = new Error(`offline / unreachable: ${e.message}`); err.offline = true; throw err
  }
  if (!resp.ok) {
    const err = new Error(`upstream HTTP ${resp.status}`); err.status = resp.status; throw err
  }
  const contentType = resp.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await resp.arrayBuffer())

  // 3. persist atomically (bytes + content-type sidecar)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${buffer.length}`
  await fsp.writeFile(tmp, buffer)
  await fsp.rename(tmp, file)
  await fsp.writeFile(meta, contentType).catch(() => {})
  return { buffer, contentType, fromCache: false }
}

module.exports = { getResource, storePaths }
