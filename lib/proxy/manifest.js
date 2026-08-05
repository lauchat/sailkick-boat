'use strict'

// Cache-manifest poller. The cloud sailkick host publishes a small manifest that
// announces the current bake id per dataset:
//
//   { "app": "2026-07-19a",
//     "bakes": { "tiles/osm-standard": "v3", "tiles/seamap": "2026-06", "terrain": "2026-01" } }
//
// We poll it (only when online — a fetch failure is a no-op), and remember the
// last-seen id per family plus the moment we first learned a NEW id
// (invalidatedAt). cache.js treats any cached file older than its family's
// invalidatedAt as stale → lazy refetch when online, serve-stale when offline.
// Tiles are otherwise PINNED forever, so there is no per-tile time revalidation.
//
// Families come from the `bakes` keys (path prefixes); everything else (the app
// shell, cached /api GETs) belongs to a synthetic `app` family keyed on `app`.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

function createManifest (app, options) {
  const log = (m) => (app.debug ? app.debug('[manifest] ' + m) : console.log('[sailkick-boat:manifest]', m))
  let cfg = null
  let timer = null
  let known = {} // family -> { id, invalidatedAt }
  let lastOk = 0

  function start () {
    cfg = {
      upstream: options.upstream.replace(/\/+$/, ''),
      path: options.manifestPath || '/api/cache-manifest',
      stateFile: path.join(options.storeDir, '.cache-manifest.json'),
      intervalMs: Math.max(30000, (options.pollIntervalSec || 300) * 1000),
      timeoutMs: options.timeoutMs || 15000
    }
    load()
    poll() // immediate first check
    timer = setInterval(poll, cfg.intervalMs)
    if (timer.unref) timer.unref()
    log(`polling ${cfg.upstream}${cfg.path} every ${Math.round(cfg.intervalMs / 1000)}s`)
  }

  function stop () {
    if (timer) clearInterval(timer)
    timer = null
    cfg = null
  }

  function load () {
    try { known = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) || {} } catch { known = {} }
  }
  async function save () {
    try {
      await fsp.mkdir(path.dirname(cfg.stateFile), { recursive: true })
      await fsp.writeFile(cfg.stateFile, JSON.stringify(known))
    } catch {}
  }

  async function poll () {
    if (!cfg) return
    let m
    try {
      const resp = await fetch(cfg.upstream + cfg.path, { signal: AbortSignal.timeout(cfg.timeoutMs) })
      if (!resp.ok) return
      m = await resp.json()
    } catch { return } // offline / bad JSON → no-op, nothing invalidated
    lastOk = Date.now()

    // We are online and talking to the app server — the one moment worth re-checking
    // the signalk-map contract seam. Piggybacking here keeps it to one timer, and it
    // must never affect cache invalidation, so it is fire-and-forget.
    if (options.contract) { try { options.contract.check(cfg.upstream) } catch {} }

    const families = { ...((m && m.bakes) || {}) }
    if (m && m.app != null) families.app = m.app

    let changed = false
    const now = Date.now()
    for (const [fam, id] of Object.entries(families)) {
      const sid = String(id)
      const prev = known[fam]
      if (!prev) {
        // First sight of a family: record the id but DON'T invalidate — the boat's
        // pre-populated store is valid for whatever it already has.
        known[fam] = { id: sid, invalidatedAt: 0 }
        changed = true
      } else if (prev.id !== sid) {
        known[fam] = { id: sid, invalidatedAt: now }
        changed = true
        log(`bake changed: ${fam} ${prev.id} -> ${sid} (older files refresh lazily)`)
      }
    }
    if (changed) await save()
  }

  // Family of a request path = the longest matching bake prefix, else 'app'.
  function familyFor (reqPath) {
    const p = reqPath.replace(/^\/+/, '').split('?')[0]
    let best = null
    for (const fam of Object.keys(known)) {
      if (fam === 'app') continue
      const pref = fam.replace(/\/+$/, '')
      if (p === pref || p.startsWith(pref + '/')) {
        if (!best || pref.length > best.length) best = pref
      }
    }
    return best || 'app'
  }

  function invalidatedAtFor (reqPath) {
    const fam = familyFor(reqPath)
    return (known[fam] && known[fam].invalidatedAt) || 0
  }

  function status () {
    if (!cfg) return 'manifest: off'
    const n = Object.keys(known).length
    const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) + 's ago' : 'never'
    return `manifest: ${n} families, synced ${age}`
  }

  return { start, stop, status, invalidatedAtFor, familyFor, _poll: poll, _known: () => known }
}

module.exports = { createManifest }
