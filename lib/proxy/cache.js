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
const { request } = require('../net') // owned connection pool + real error codes; see lib/net.js
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
    resp = await request(url, { timeoutMs })
  } catch (e) {
    const err = new Error(`offline / unreachable: ${e.message}`); err.offline = true; throw err
  }
  if (!resp.ok) {
    if (resp.status === 404) {
      // Negative-cache empty tiles (sparse layers — coastline/seamap — 404 on empty
      // tiles) with a sentinel, so offline they read as "empty" (404) instead of
      // hitting the circuit breaker, and a re-seed skips them with no network.
      await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
      await fsp.writeFile(file + '.404', '').catch(() => {})
    }
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

// opts: { storeDir, upstream, reqPath, timeoutMs, invalidatedAt, networkFirst, health }
// returns { buffer, contentType, cacheState, fromCache }; throws (err.offline /
// err.status) only when neither cached nor fetchable.
//
// Two strategies:
//   cache-first  (default; static assets + tiles) — serve disk if present, pinned
//     until a bake is announced (invalidatedAt). HIT / UPDATED / STALE / MISS.
//   networkFirst (dynamic /api data — AIS, weather) — fetch LIVE each time, fall
//     back to the cached copy only when offline (STALE). Never serves stale live
//     data while online.
//
// `health` is a shared { downUntil, cooldownMs } circuit breaker: once a fetch
// fails offline, the upstream is treated as down for cooldownMs, so subsequent
// uncached requests FAIL FAST (no per-request timeout hang that would starve the
// browser's connection pool) — cached HITs are unaffected. A success clears it.
async function getResource (opts) {
  const { storeDir, upstream, reqPath, timeoutMs = 20000, invalidatedAt = 0, networkFirst = false, health = null } = opts
  const { file, meta } = storePaths(storeDir, reqPath)
  const url = upstream.replace(/\/+$/, '') + reqPath
  const downNow = !!(health && Date.now() < health.downUntil)

  const serveDisk = async (state) => ({ ...(await readFromDisk(file, meta)), cacheState: state, fromCache: true })
  const tryFetch = async (state) => {
    const r = await fetchAndStore(url, file, meta, timeoutMs)
    if (health) health.downUntil = 0 // upstream answered → clear the breaker
    return { ...r, cacheState: state, fromCache: false }
  }
  const noteFail = (e) => { if (health && e.offline) health.downUntil = Date.now() + (health.cooldownMs || 15000) }
  const offline = (msg) => { const e = new Error(msg); e.offline = true; return e }

  if (networkFirst) {
    const stat = await fsp.stat(file).catch(() => null)
    if (downNow) { if (stat) return serveDisk('STALE'); throw offline('offline / not cached') }
    try { return await tryFetch('LIVE') } catch (e) { noteFail(e); if (stat) return serveDisk('STALE'); throw e }
  }

  // cache-first
  const stat = await fsp.stat(file).catch(() => null)
  if (stat) {
    const stale = invalidatedAt && stat.mtimeMs < invalidatedAt
    if (!stale) return serveDisk('HIT')
    // A newer bake was announced; the on-disk copy predates it.
    if (downNow) return serveDisk('STALE')
    try { return await tryFetch('UPDATED') } catch (e) { noteFail(e); return serveDisk('STALE') }
  }
  // not cached — but maybe negative-cached (known-empty tile)
  const emptyStat = await fsp.stat(file + '.404').catch(() => null)
  if (emptyStat && !(invalidatedAt && emptyStat.mtimeMs < invalidatedAt)) {
    const err = new Error('empty (404, cached)'); err.status = 404; throw err // no fetch
  }
  if (downNow) throw offline('offline / not cached (circuit open)') // fast-fail — don't hang the pool
  try { return await tryFetch('MISS') } catch (e) { noteFail(e); throw e }
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
