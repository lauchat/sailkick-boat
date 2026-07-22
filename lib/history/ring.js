'use strict'

// DB-less history provider — a rolling ring sampled from the live telemetry
// BoatState (the same state that feeds /ws/telemetry). The edge path when there's
// no local InfluxDB (e.g. SignalK on a Victron GX / Venus OS). Serves the SAME
// series/track contract as the InfluxDB provider; TWS/TWD are derived from apparent
// wind + boat motion (as the ribbon does), STW is simply absent.
//
// Persistence (optional, `persistFile`): a JSONL APPEND-LOG so the ring survives
// restarts and can cover a long passage cheaply. Each sample is appended as one
// line (~160 B); the file is compacted (atomic rewrite to the current window) only
// rarely — on start, once appends exceed the ring length, and on destroy — so write
// load is per-sample, decoupled from window size (< ~1 GB over a 30-day passage vs
// ~600 GB for a full-rewrite-every-2min snapshot). To keep RAM/disk bounded at any
// window, the sample rate auto-coarsens so the ring never exceeds ~MAX_SAMPLES rows
// (24 h → 15 s, 30 d → ~52 s). All fs is guarded — a missing/corrupt file just means
// an empty start; appends + compactions are serialized so they can't interleave.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const DEG = Math.PI / 180
const wrap360 = (d) => ((d % 360) + 360) % 360
const MAX_SAMPLES = 50000

// True wind (TWS kt, TWD ° the wind blows FROM) from apparent + motion over ground.
function trueWind (s) {
  if (!Number.isFinite(s.awsKt) || !Number.isFinite(s.awaDeg) || !Number.isFinite(s.headingDeg)) return null
  const a = s.awaDeg * DEG
  const x = s.awsKt * Math.cos(a) - (s.sogKt || 0); const y = s.awsKt * Math.sin(a)
  return { tws: Math.hypot(x, y), twd: wrap360(s.headingDeg + Math.atan2(y, x) / DEG) }
}

class RingHistoryProvider {
  constructor ({ source, sampleSec, windowSec, persistFile } = {}) {
    this._source = source
    this._ring = [] // [{ t, sog, cog, heading, aws, awa, depth, tws, twd, lat, lon }]
    const win = windowSec || 3600
    this._windowMs = win * 1000
    this._persistFile = persistFile || null
    this._io = Promise.resolve() // serialized fs writes (append/compact never interleave)
    this._appendedSinceCompact = 0
    // auto-coarsen so the ring is bounded (~MAX_SAMPLES rows) regardless of window
    const stepSec = Math.max(sampleSec || 15, Math.ceil(win / MAX_SAMPLES))
    this._stepSec = stepSec

    this._load() // seed from disk (survives restart)
    this._compactSync() // rewrite clean + bounded, synchronously (file exists right at start)
    this._sample() // immediate first sample
    this._timer = setInterval(() => this._sample(), stepSec * 1000)
    if (this._timer.unref) this._timer.unref()
  }

  // --- sampling ---
  _sample () {
    const s = this._source && this._source.getState && this._source.getState()
    if (!s) return
    const tw = trueWind(s)
    const num = (v) => (Number.isFinite(v) ? v : null)
    const row = {
      t: Date.now(),
      sog: num(s.sogKt), cog: num(s.cogDeg), heading: num(s.headingDeg),
      aws: num(s.awsKt), awa: num(s.awaDeg), depth: num(s.depthM),
      tws: tw ? tw.tws : null, twd: tw ? tw.twd : null,
      lat: num(s.lat), lon: num(s.lon)
    }
    this._ring.push(row)
    const cutoff = Date.now() - this._windowMs
    while (this._ring.length && this._ring[0].t < cutoff) this._ring.shift()
    this._append(row)
  }

  available () { return true }

  _window (windowSec) {
    const cutoff = Date.now() - Math.min(windowSec * 1000, this._windowMs)
    return this._ring.filter((r) => r.t >= cutoff)
  }

  getSeries ({ windowSec } = {}) {
    const rows = this._window(windowSec)
    const chans = ['tws', 'twd', 'aws', 'awa', 'sog', 'heading', 'depth'] // no STW in BoatState
    const series = {}
    for (const c of chans) {
      const pts = rows.filter((r) => r[c] != null).map((r) => [r.t, r[c]])
      if (pts.length) series[c] = pts
    }
    return { ok: true, series }
  }

  getTrack ({ windowSec } = {}) {
    const track = this._window(windowSec)
      .filter((r) => r.lat != null && r.lon != null)
      .map((r) => ({ t: r.t, lat: r.lat, lon: r.lon }))
    return { ok: true, track }
  }

  // --- persistence ---
  _load () {
    if (!this._persistFile) return
    let text
    try { text = fs.readFileSync(this._persistFile, 'utf8') } catch { return }
    const cutoff = Date.now() - this._windowMs
    let rows = []
    for (const line of text.split('\n')) {
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { continue } // skip a torn/corrupt line
      if (r && typeof r.t === 'number' && r.t >= cutoff) rows.push(r)
    }
    rows.sort((a, b) => a.t - b.t)
    if (rows.length > MAX_SAMPLES) rows = rows.slice(-MAX_SAMPLES)
    this._ring = rows
  }

  _append (row) {
    if (!this._persistFile) return
    const line = JSON.stringify(row) + '\n'
    this._io = this._io.then(() => fsp.appendFile(this._persistFile, line)).catch(() => {})
    // compact once the log has grown by ~a full window past its last rewrite
    if (++this._appendedSinceCompact > Math.max(64, this._ring.length)) this._compact()
  }

  _serialize () {
    return this._ring.map((r) => JSON.stringify(r)).join('\n') + (this._ring.length ? '\n' : '')
  }

  _compact () {
    if (!this._persistFile) return
    this._appendedSinceCompact = 0
    const data = this._serialize()
    const file = this._persistFile
    this._io = this._io.then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      await fsp.writeFile(tmp, data)
      await fsp.rename(tmp, file)
    }).catch(() => {})
  }

  // synchronous compaction — only at construct, so the file exists immediately.
  _compactSync () {
    if (!this._persistFile) return
    this._appendedSinceCompact = 0
    try {
      fs.mkdirSync(path.dirname(this._persistFile), { recursive: true })
      const tmp = `${this._persistFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, this._serialize())
      fs.renameSync(tmp, this._persistFile)
    } catch {}
  }

  _flush () { return this._io } // tests: await all pending writes

  destroy () {
    clearInterval(this._timer)
    this._compact() // final flush of the current ring
  }
}

module.exports = { RingHistoryProvider, MAX_SAMPLES }
