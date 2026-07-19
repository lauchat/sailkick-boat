'use strict'

// Caching mirror of a single upstream (the sailkick host). getResource() serves
// a path from the on-disk store if present, else fetches it from the upstream,
// stores it (bytes + content-type sidecar) atomically, and serves it — so any
// resource (tiles, JSON, app assets) is fetched once online then served forever
// offline. The Node/proxy_store equivalent, generalized beyond tiles.
//
// Freshness (v0.6.0): tiles are PINNED — never expired by time. A cached file is
// only treated as stale when its family's bake was re-announced by the cloud (see
// manifest.js): callers pass `invalidatedAt` = the ms timestamp at which a newer
// bake for this path's family was learned. A file older than that is refetched
// lazily when online (UPDATED) or served stale when offline (STALE). No blind TTLs.

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

async function readFromDisk (file, meta) {
  const buffer = await fsp.readFile(file)
  let contentType = 'application/octet-stream'
  try { contentType = (await fsp.readFile(meta, 'utf8')).trim() || contentType } catch {}
  return { buffer, contentType }
}

// Fetch from upstream and persist atomically (bytes + content-type sidecar). The
// rename stamps the file mtime ~now, which is what freshness compares against.
async function fetchAndStore (url, file, meta, timeoutMs) {
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
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${buffer.length}`
  await fsp.writeFile(tmp, buffer)
  await fsp.rename(tmp, file)
  await fsp.writeFile(meta, contentType).catch(() => {})
  return { buffer, contentType }
}

// opts: { storeDir, upstream, reqPath, timeoutMs, invalidatedAt }
// returns { buffer, contentType, cacheState, fromCache }; throws (err.offline /
// err.status) only when neither cached nor fetchable.
//   HIT     — served from disk, current
//   UPDATED — was stale (bake re-announced), refetched fresh online
//   STALE   — was stale but upstream unreachable, served old copy (offline-first)
//   MISS    — not cached, fetched now
async function getResource (opts) {
  const { storeDir, upstream, reqPath, timeoutMs = 20000, invalidatedAt = 0 } = opts
  const { file, meta } = storePaths(storeDir, reqPath)
  const url = upstream.replace(/\/+$/, '') + reqPath

  const stat = await fsp.stat(file).catch(() => null)
  if (stat) {
    const stale = invalidatedAt && stat.mtimeMs < invalidatedAt
    if (!stale) {
      const r = await readFromDisk(file, meta)
      return { ...r, cacheState: 'HIT', fromCache: true }
    }
    // A newer bake was announced for this family; the on-disk copy predates it.
    try {
      const r = await fetchAndStore(url, file, meta, timeoutMs)
      return { ...r, cacheState: 'UPDATED', fromCache: false }
    } catch (e) {
      // offline / upstream error → keep serving the stale copy (offline-first)
      const r = await readFromDisk(file, meta)
      return { ...r, cacheState: 'STALE', fromCache: true }
    }
  }

  // not cached
  const r = await fetchAndStore(url, file, meta, timeoutMs)
  return { ...r, cacheState: 'MISS', fromCache: false }
}

// Manual force-refresh helper. Two modes:
//   { prefix: 'tiles/osm-standard' } — delete that subtree (a specific tileset)
//   { keep: ['tiles', 'terrain'] }   — delete all top-level entries EXCEPT these
// Deleted files re-fetch fresh on next request. Returns { removed }.
async function clearStore ({ storeDir, keep = [], prefix = '' } = {}) {
  const root = path.resolve(storeDir)
  if (prefix) {
    const target = path.resolve(root, String(prefix).replace(/^\/+/, ''))
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('invalid prefix')
    await fsp.rm(target, { recursive: true, force: true })
    return { removed: 1, mode: 'prefix', prefix }
  }
  const keepSet = new Set(keep)
  const entries = await fsp.readdir(root).catch(() => [])
  let removed = 0
  for (const e of entries) {
    if (keepSet.has(e)) continue
    await fsp.rm(path.join(root, e), { recursive: true, force: true })
    removed++
  }
  return { removed, mode: 'keep', kept: [...keepSet] }
}

module.exports = { getResource, storePaths, clearStore }
