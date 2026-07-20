'use strict'

// Global offline base seeder. Warms two worldwide layers into the mirror cache so a
// usable map exists offline everywhere (not just where you browsed):
//   - seabed  = the `bathy` raster (dense global): enumerate z0..seabedMaxZoom fully.
//   - coastline = sparse vector .pbf: parent-guided descent from z0 — only descend
//     into non-empty tiles (empty tiles 404 → negative-cached, not descended). Coast
//     is continuous across zoom, so every non-empty child has a non-empty parent, so
//     the descent is complete while probing ~4x the real tiles (not the full pyramid).
//
// Warms via getResource (cache-first) so it is idempotent/resumable: already-cached
// tiles and negative-cached empties cost no network. Reuses the shared `health`
// breaker — goes quiet when offline and resumes when back online. Fire-and-forget.

const { getResource } = require('./cache')

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })

function createSeeder (app, opts) {
  const log = (m) => (app.debug ? app.debug('[seed] ' + m) : console.log('[sailkick-boat:seed]', m))
  let cfg = null
  let running = false
  let stopped = false
  let runPromise = null
  const counts = { coastline: 0, coastEmpty: 0, seabed: 0, seabedEmpty: 0, failed: 0 }

  function start () {
    cfg = {
      upstream: opts.upstream.replace(/\/+$/, ''),
      storeDir: opts.storeDir,
      timeoutMs: opts.timeoutMs || 20000,
      health: opts.health || null,
      manifest: opts.manifest || null,
      coastlineMaxZoom: opts.coastlineMaxZoom == null ? 8 : opts.coastlineMaxZoom,
      seabedMaxZoom: opts.seabedMaxZoom == null ? 6 : opts.seabedMaxZoom,
      concurrency: Math.max(1, opts.concurrency || 4),
      offlinePollMs: opts.offlinePollMs || 2000
    }
    stopped = false
    runPromise = run().catch((e) => log('seed error: ' + e.message))
    return runPromise
  }

  function stop () { stopped = true }

  function status () {
    if (!cfg) return 'seed: off'
    return `seed: coastline ${counts.coastline}, seabed ${counts.seabed} (${running ? 'running' : 'done'})`
  }

  async function waitIfOffline () {
    while (!stopped && cfg.health && Date.now() < cfg.health.downUntil) await sleep(cfg.offlinePollMs)
  }

  // Warm one tile. Retries indefinitely while offline (circuit open) so the seed
  // survives connectivity gaps. Returns {ok} | {empty} (404) | {failed} | {stopped}.
  async function warm (reqPath) {
    for (;;) {
      await waitIfOffline()
      if (stopped) return { stopped: true }
      try {
        await getResource({
          storeDir: cfg.storeDir,
          upstream: cfg.upstream,
          reqPath,
          timeoutMs: cfg.timeoutMs,
          health: cfg.health,
          invalidatedAt: cfg.manifest ? cfg.manifest.invalidatedAtFor(reqPath) : 0
        })
        return { ok: true }
      } catch (e) {
        if (e.status === 404) return { empty: true }
        if (e.offline) { await sleep(cfg.offlinePollMs); continue } // went offline mid-flight → wait + retry
        return { failed: true } // e.g. a 5xx — skip this tile
      }
    }
  }

  async function pool (worker) {
    await Promise.all(Array.from({ length: cfg.concurrency }, () => worker()))
  }

  async function seedSeabed () {
    const tiles = []
    for (let z = 0; z <= cfg.seabedMaxZoom; z++) {
      const n = 2 ** z
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) tiles.push([z, x, y])
    }
    let i = 0
    await pool(async () => {
      while (!stopped && i < tiles.length) {
        const [z, x, y] = tiles[i++]
        const r = await warm(`/tiles/bathy/${z}/${x}/${y}.png`)
        if (r.stopped) return
        if (r.ok) counts.seabed++; else if (r.empty) counts.seabedEmpty++; else counts.failed++
      }
    })
  }

  async function seedCoastline () {
    const queue = [[0, 0, 0]]
    let active = 0
    await pool(async () => {
      while (!stopped) {
        const t = queue.shift() // shift + active++ are synchronous (no await between) → atomic
        if (!t) { if (active === 0) return; await sleep(50); continue }
        active++
        const [z, x, y] = t
        const r = await warm(`/tiles/coastline/${z}/${x}/${y}.pbf`)
        if (r.stopped) { active--; return }
        if (r.ok) {
          counts.coastline++
          if (z < cfg.coastlineMaxZoom) {
            const nz = z + 1; const nx = x * 2; const ny = y * 2
            queue.push([nz, nx, ny], [nz, nx + 1, ny], [nz, nx, ny + 1], [nz, nx + 1, ny + 1])
          }
        } else if (r.empty) counts.coastEmpty++
        else counts.failed++
        active--
      }
    })
  }

  async function run () {
    running = true
    log(`seeding: coastline z0-${cfg.coastlineMaxZoom}, seabed z0-${cfg.seabedMaxZoom}, concurrency ${cfg.concurrency}`)
    try {
      await seedSeabed()
      await seedCoastline()
      if (!stopped) log(`seed complete: coastline ${counts.coastline} (+${counts.coastEmpty} empty), seabed ${counts.seabed} (+${counts.seabedEmpty} empty), failed ${counts.failed}`)
    } finally {
      running = false
    }
  }

  return { start, stop, status, _wait: () => runPromise, _counts: () => counts }
}

module.exports = { createSeeder }
