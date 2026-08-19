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

// The channel set the Trends panel and the instrument history flyouts expect. It must
// match the cloud's provider (sailkick server/history/influx-provider.js MAP + the
// three active-waypoint prefixes), so the same cell shows the same history whether the
// boat or the cloud is answering.
//
// This drifted once already: it was frozen at the eight channels that existed before
// v0.18.6, while the app grew cells for true wind angle, VMG, temperatures, engine revs
// and the four waypoint values — and `cog` was sampled into the ring but left out of the
// output entirely. Eleven of nineteen cells had a live number and an empty flyout.
// test/history-ring.test.js pins this list against the app's own channel names.
const CHANNELS = [
  'tws', 'twd', 'aws', 'awa', 'twa', 'vmg',
  'sog', 'stw', 'cog', 'heading', 'depth',
  'seaTemp', 'airTemp', 'rpmPort', 'rpmStbd',
  'wptBrg', 'wptDist', 'wptVmg', 'wptTtg',
  // Computed on the boat (lib/perf) rather than read off the bus: percentage of polar
  // target. Null whenever the guards do not pass — in irons, under 2 kt, no polar — so
  // the channel GAPS instead of flat-lining at zero, which would drag every average
  // drawn over it.
  'perf'
]
const wrap360 = (d) => ((d % 360) + 360) % 360
const MAX_SAMPLES = 50000

// True wind (TWS kt, TWD ° the wind blows FROM).
//
// Prefer what the instruments publish. A wind system computes true wind from its own
// calibrated apparent wind with heel and leeway correction and a water-referenced boat
// speed — strictly better than anything derivable here, and it is what every other
// display on board shows, so deriving a second answer would just disagree with them.
//
// Only when the boat publishes no true wind do we derive it, and then from speed
// THROUGH WATER: true wind is defined relative to the boat's motion through the water,
// not over the ground. Using SOG (as this did before v0.14.6) skews both TWS and TWD in
// any tidal stream — several degrees and about a knot in 3 kt of tide, which is exactly
// the error you would be trimming against. SOG remains the last resort for boats with
// no paddlewheel, where it is at least right in slack water.
function trueWind (s) {
  if (Number.isFinite(s.twsKt) && Number.isFinite(s.twdDeg)) {
    return { tws: s.twsKt, twd: wrap360(s.twdDeg), measured: true }
  }
  if (!Number.isFinite(s.awsKt) || !Number.isFinite(s.awaDeg) || !Number.isFinite(s.headingDeg)) return null
  const boatSpeed = Number.isFinite(s.stwKt) ? s.stwKt : (Number.isFinite(s.sogKt) ? s.sogKt : 0)
  const a = s.awaDeg * DEG
  const x = s.awsKt * Math.cos(a) - boatSpeed; const y = s.awsKt * Math.sin(a)
  return { tws: Math.hypot(x, y), twd: wrap360(s.headingDeg + Math.atan2(y, x) / DEG), measured: false }
}

class RingHistoryProvider {
  constructor ({ source, perfSource, sampleSec, windowSec, persistFile } = {}) {
    this._source = source
    this._perfSource = perfSource || null
    this._ring = [] // [{ t, ...CHANNELS, lat, lon }]
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
      stw: num(s.stwKt),
      aws: num(s.awsKt), awa: num(s.awaDeg), depth: num(s.depthM),
      tws: tw ? tw.tws : null, twd: tw ? tw.twd : null,
      // Everything below arrived in BoatState with v0.18.6 but was never sampled here,
      // so these instrument cells had a live value and an empty history flyout.
      twa: num(s.twaDeg), vmg: num(s.vmgKt),
      seaTemp: num(s.seaTempC), airTemp: num(s.airTempC),
      rpmPort: num(s.rpmPort), rpmStbd: num(s.rpmStbd),
      // Waypoint channels are legitimately null when no destination is active — num()
      // maps that to null and CHANNELS omits empty ones, so the flyout stays blank
      // rather than showing a flat line at zero.
      wptBrg: num(s.wptBrgDeg), wptDist: num(s.wptDistNm),
      wptVmg: num(s.wptVmgKt), wptTtg: num(s.wptTtgSec),
      perf: this._perfSource ? num(this._perfSource.getPerf()) : null,
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
    const series = {}
    for (const c of CHANNELS) {
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

module.exports = { RingHistoryProvider, MAX_SAMPLES, CHANNELS }
