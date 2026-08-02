'use strict'

// Backfill: copy an older local InfluxDB into the boat's cloud bucket.
//
// The point is history from BEFORE this boat ever synced. Live sync only ever sees
// deltas arriving now, and the spool only replays what it captured itself while offline,
// so nothing else in the plugin can reach back.
//
// The control flow is lifted from sailkick-sync/tools/import-bandg.sh, which has already
// done this job for real: newest-first hour windows, count-before-fetch, a manifest of
// completed windows, verify each window against the destination, and abort a run after
// consecutive errors so a boat that has gone offline never marks a window falsely done.
// The difference is direction — that script PULLS from the boat and must reach its
// InfluxDB inbound, which a boat on a mobile link cannot offer, so this PUSHES.
//
// Safety rests on two things. Writes are idempotent on (measurement, tagset, ns
// timestamp), so re-running is always harmless. And every window is verified by counting
// the destination, which is why this needs a read+write cloud token rather than the
// write-only one live sync uses: a 204 means InfluxDB accepted the bytes, not that every
// point landed. That token is only needed during the migration and can be revoked after,
// leaving live sync on its least-privilege token.

const fs = require('fs')
const path = require('path')
const { writeLines } = require('../sync/influxWrite')
const { csvToLineProtocol } = require('./lineproto')

const HOUR_MS = 3600000
const DEFAULTS = {
  windowMs: HOUR_MS,
  batchSize: 10000,
  idleMs: 2000, // breathing room between windows so a slow link isn't monopolised
  backlogWaitMs: 15000, // how long to stand down when live sync has a backlog
  maxErrorStreak: 5,
  queryTimeoutMs: 120000
}

const iso = (ms) => new Date(ms).toISOString()
const hourFloor = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })

function createBackfill (app, options) {
  const log = (m) => (app.debug ? app.debug('[backfill] ' + m) : console.log('[sailkick-boat:backfill]', m))
  const warn = (m) => (app.error ? app.error('[sailkick-boat:backfill] ' + m) : console.error('[sailkick-boat:backfill]', m))

  const cfg = {
    ...DEFAULTS,
    ...options,
    src: { ...(options.src || {}) },
    dst: { ...(options.dst || {}) }
  }
  let state = null
  let running = false
  let stopped = false
  let statusLine = 'backfill: off'
  let runPromise = null

  // --- persisted manifest -------------------------------------------------------
  function load () {
    try {
      const j = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'))
      if (j && typeof j === 'object') return { done: j.done || {}, earliest: j.earliest || null, points: j.points || 0, complete: !!j.complete }
    } catch {}
    return { done: {}, earliest: null, points: 0, complete: false }
  }
  function save () {
    try {
      fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true })
      const tmp = `${cfg.stateFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      fs.renameSync(tmp, cfg.stateFile)
    } catch (e) { warn('could not persist progress: ' + e.message) }
  }

  // --- InfluxDB reads -----------------------------------------------------------
  async function flux (conn, body) {
    const url = `${conn.url.replace(/\/+$/, '')}/api/v2/query?org=${encodeURIComponent(conn.org)}`
    let resp
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Token ${conn.token}`, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' },
        body,
        signal: AbortSignal.timeout(cfg.queryTimeoutMs)
      })
    } catch (e) { return { ok: false, message: e.message } }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      return { ok: false, status: resp.status, message: `HTTP ${resp.status}: ${t.slice(0, 160)}` }
    }
    return { ok: true, text: await resp.text() }
  }

  // Total points in a window. Returns a number, or null on ANY transport/HTTP failure —
  // never 0, so an unreachable database can't be mistaken for "no data here" and mark a
  // window falsely done. (The source script is emphatic about this distinction.)
  async function count (conn, bucket, startMs, stopMs) {
    const r = await flux(conn, `from(bucket:"${bucket}")|>range(start:${iso(startMs)},stop:${iso(stopMs)})|>count()|>group()|>sum()|>keep(columns:["_value"])`)
    if (!r.ok) return null
    for (const line of r.text.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const cells = line.trim().split(',')
      const last = cells[cells.length - 1]
      if (/^\d+$/.test(last)) return Number(last)
    }
    return 0
  }

  async function earliestPoint () {
    // `first()` reduces each series before anything is merged, then _time is isolated
    // BEFORE group(). Both matter on a real bucket: grouping the raw stream fails with
    // "schema collision: cannot group boolean and integer types together" the moment the
    // database holds more than one field type, which any real boat's does.
    const r = await flux(cfg.src, `from(bucket:"${cfg.src.bucket}")|>range(start:0)|>first()|>keep(columns:["_time"])|>group()|>min(column:"_time")`)
    if (!r.ok) return null
    for (const line of r.text.split('\n')) {
      if (!line || line.startsWith('#') || line.includes('_time')) continue
      for (const cell of line.split(',')) {
        // Must look like RFC3339. Date.parse is far too permissive for scanning cells:
        // the CSV's `table` column is "0", and Date.parse('0') happily returns the year
        // 2000 — which would set the floor 26 years too early and walk a quarter of a
        // million empty windows.
        if (!/^\d{4}-\d{2}-\d{2}T/.test(cell.trim())) continue
        const ms = Date.parse(cell.trim())
        if (!Number.isNaN(ms)) return ms
      }
    }
    return null
  }

  // Distinct contexts in the source bucket. Returns null on any failure — never an
  // empty list, so an unreachable database is not mistaken for an empty archive.
  async function sourceContexts () {
    const r = await flux(cfg.src, `import "influxdata/influxdb/schema"\nschema.tagValues(bucket:"${cfg.src.bucket}", tag:"context")`)
    if (!r.ok) return null
    const out = []
    for (const line of r.text.split('\n')) {
      if (!line || line.startsWith('#')) continue
      const cells = line.trim().split(',')
      const v = cells[cells.length - 1]
      if (v && v !== '_value') out.push(v)
    }
    return out
  }

  // The plugin must never upload data that is not this boat's. Live sync guarantees
  // that by subscribing to vessels.self; the backfill is the only thing that could
  // break it, and the cloud's history queries depend on it holding. So this is decided
  // in code, not exposed as an option someone can get wrong.
  //
  // The wrinkle: an imported archive may carry a DIFFERENT context than the boat's
  // current identity — a UUID from a since-reinstalled Signal K, or an MMSI URN. A
  // strict match would then copy nothing, silently. Hence the single-context rule: a
  // bucket holding exactly one context contains one vessel by definition and cannot be
  // an AIS collection, so it is copied whatever its identity string says.
  function contextFilterFor (contexts) {
    const selfCtx = cfg.selfContext
    if (cfg.context) {
      log(`copying only context ${cfg.context} (explicit override)`)
      return `|>filter(fn:(r)=>r.context=="${cfg.context}")`
    }
    if (contexts.length <= 1) {
      log(`source holds a single context (${contexts[0] || 'none'}) — copying all of it`)
      return ''
    }
    const others = contexts.filter((c) => c !== selfCtx)
    warn(`source holds ${contexts.length} contexts — copying only this boat (${selfCtx}) and skipping ${others.length} other(s), e.g. ${others.slice(0, 3).join(', ')}`)
    return `|>filter(fn:(r)=>r.self=="true" or r.context=="${selfCtx}")`
  }

  // --- one window ---------------------------------------------------------------
  // Returns 'done' | 'empty' | 'retry' | 'stopped'.
  async function doWindow (startMs, stopMs) {
    const srcCount = await count(cfg.src, cfg.src.bucket, startMs, stopMs)
    if (srcCount == null) return 'retry'
    if (srcCount === 0) return 'empty'

    const filter = cfg._filter || ''
    const r = await flux(cfg.src, `from(bucket:"${cfg.src.bucket}")|>range(start:${iso(startMs)},stop:${iso(stopMs)})${filter}|>drop(columns:["_start","_stop"])`)
    if (!r.ok) { warn(`read ${iso(startMs)} failed — ${r.message}`); return 'retry' }

    const { lines, skipped } = csvToLineProtocol(r.text)
    if (skipped) log(`${iso(startMs)}: skipped ${skipped} unconvertible row(s)`)
    if (!lines.length) return 'empty'

    for (let i = 0; i < lines.length; i += cfg.batchSize) {
      if (stopped) return 'stopped'
      const body = lines.slice(i, i + cfg.batchSize).join('\n') + '\n'
      const res = await writeLines({ influxUrl: cfg.dst.url, org: cfg.dst.org, bucket: cfg.dst.bucket, token: cfg.dst.token, timeoutMs: cfg.queryTimeoutMs }, body)
      if (!res.ok) {
        // 4xx is fatal: bad credentials or malformed data, and retrying cannot fix it.
        if (!res.retryable) { warn(`write REJECTED (HTTP ${res.status}) — ${res.body ? String(res.body).slice(0, 160) : 'no detail'}`); return 'fatal' }
        warn(`write ${iso(startMs)} failed — ${res.status ? 'HTTP ' + res.status : 'unreachable'}; will retry`)
        return 'retry'
      }
    }

    // Verify: a 204 says the bytes were accepted, not that every point landed. This is
    // the check the write-only sync token could never perform.
    const dstCount = await count(cfg.dst, cfg.dst.bucket, startMs, stopMs)
    if (dstCount == null) { warn(`could not verify ${iso(startMs)} — leaving it for the next run`); return 'retry' }
    if (dstCount < lines.length) {
      warn(`${iso(startMs)} MISMATCH: wrote ${lines.length}, destination has ${dstCount} — not marking done`)
      return 'retry'
    }
    if (state) state.points += lines.length
    return 'done'
  }

  // --- the walk -----------------------------------------------------------------
  async function run () {
    running = true
    try {
      // Validate the source and decide the filter before walking 15k windows.
      const contexts = await sourceContexts()
      if (contexts == null) { warn(`could not read contexts from ${cfg.src.bucket} — is the source reachable?`); statusLine = 'backfill: source unreachable'; return }
      if (!contexts.length) {
        warn(`source bucket "${cfg.src.bucket}" (org "${cfg.src.org}") holds no data at all — check the org and bucket names`)
        statusLine = `backfill: source ${cfg.src.org}/${cfg.src.bucket} is empty — check the names`
        return
      }
      cfg._filter = contextFilterFor(contexts)

      if (state.earliest == null) {
        const e = await earliestPoint()
        if (e == null) { warn('could not read the oldest point from the source — is it reachable?'); statusLine = 'backfill: source unreachable'; return }
        state.earliest = e
        log(`oldest point in ${cfg.src.bucket}: ${iso(e)}`)
        save()
      }
      // Floor to the START of the hour that CONTAINS the oldest point. Comparing the
      // cursor against the raw timestamp drops that window entirely — the loop stops as
      // soon as the next cursor falls below it, so an archive whose first point is at
      // 21:20 never gets its 21:00 window copied. That is silent data loss at the very
      // edge the backfill exists to reach.
      const rawFloor = cfg.startBound ? Math.max(state.earliest, Date.parse(cfg.startBound)) : state.earliest
      const floor = hourFloor(rawFloor)

      let cursor = hourFloor(Date.now()) // newest-first: recent history lands first
      let errStreak = 0
      let didWork = 0

      while (!stopped && cursor >= floor) {
        const startMs = cursor
        const stopMs = cursor + cfg.windowMs
        cursor -= cfg.windowMs
        const key = iso(startMs)
        if (state.done[key]) continue

        // Live telemetry is data-critical; this is not. Stand down while it is behind.
        while (!stopped && cfg.pending) {
          let depth = 0
          try { depth = (await cfg.pending()).count || 0 } catch {}
          if (!depth) break
          statusLine = `backfill: paused — live sync backlog (${depth} file(s))`
          await sleep(cfg.backlogWaitMs)
        }
        if (stopped) break

        const r = await doWindow(startMs, stopMs)
        if (r === 'stopped') break
        if (r === 'fatal') { statusLine = 'backfill: stopped — write rejected, see the log'; return }
        if (r === 'retry') {
          if (++errStreak >= cfg.maxErrorStreak) { warn(`${errStreak} consecutive failures — stopping this run, it resumes on restart`); statusLine = 'backfill: paused after repeated errors'; return }
          continue
        }
        errStreak = 0
        state.done[key] = r === 'empty' ? 'empty' : 'ok'
        didWork++
        save()
        statusLine = `backfill: ${iso(startMs).slice(0, 10)} → now, ${Object.keys(state.done).length} window(s), ${state.points} point(s)`
        await sleep(cfg.idleMs)
      }

      if (!stopped && cursor < floor) {
        if (state.points === 0) {
          // A walk that finishes having copied nothing is far more likely to be a wrong
          // org/bucket, or a filter that matched no rows, than a genuinely empty
          // archive. Marking it complete would dress a silent no-op as success and stop
          // it ever retrying.
          save()
          warn(`walked ${Object.keys(state.done).length} window(s) and copied ZERO points — check that org "${cfg.src.org}" / bucket "${cfg.src.bucket}" is right, and that its data belongs to this boat. NOT marking complete.`)
          statusLine = `backfill: finished with 0 points — check ${cfg.src.org}/${cfg.src.bucket}`
          return
        }
        state.complete = true
        save()
        statusLine = `backfill: complete — ${state.points} point(s) from ${iso(floor).slice(0, 10)}`
        log(`complete: ${Object.keys(state.done).length} windows, ${state.points} points`)
      } else if (didWork === 0 && !stopped) {
        statusLine = 'backfill: nothing to do'
      }
    } finally {
      running = false
    }
  }

  function start () {
    if (running) return runPromise
    stopped = false
    state = load()
    if (state.complete) { statusLine = `backfill: complete — ${state.points} point(s)`; return null }
    if (!cfg.src.token || !cfg.src.bucket || !cfg.src.url) { statusLine = 'backfill: not configured (source)'; return null }
    if (!cfg.dst.token || !cfg.dst.bucket) { statusLine = 'backfill: not configured (cloud token)'; return null }
    log(`${cfg.src.url} ${cfg.src.org}/${cfg.src.bucket} -> ${cfg.dst.url} ${cfg.dst.org}/${cfg.dst.bucket}`)
    statusLine = 'backfill: starting'
    runPromise = run().catch((e) => { warn('run failed: ' + e.message); statusLine = 'backfill: error — ' + e.message })
    return runPromise
  }

  function stop () { stopped = true }
  function status () { return statusLine }

  return { start, stop, status, _state: () => state, _doWindow: doWindow, _wait: () => runPromise }
}

module.exports = { createBackfill }
