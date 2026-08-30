'use strict'

// DB-less history provider — a rolling ring sampled from the live telemetry
// BoatState (the same state that feeds /ws/telemetry). The edge path when there's
// no local InfluxDB (e.g. SignalK on a Victron GX / Venus OS). Serves the SAME
// series/track contract as the InfluxDB provider; TWS/TWD are derived from apparent
// wind + boat motion (as the ribbon does), STW is simply absent.
//
// Each emitted row carries, per linear channel, the MEAN over the interval plus the true
// min/max seen inside it (`lo`/`hi`) and the sample count behind the mean (`n`) — see the
// two-clocks note in the constructor. Compass channels carry a last-reading snapshot and
// none of the three, because a bearing has no arithmetic mean.
//
// Persistence (optional, `persistFile`): a JSONL APPEND-LOG so the ring survives
// restarts and can cover a long passage cheaply. Each row is appended as one line; the
// file is compacted (atomic rewrite to the current window) only rarely — on start, once
// appends exceed the ring length, and on destroy — so write load is per-sample,
// decoupled from window size. Measured on a fully-populated row (every channel present):
// 307 B before the bands, 844 B with them, i.e. 2.7x. A 30-day passage is ~49.8k rows
// (the emit rate auto-coarsens to ~52 s, see below), so ~40 MB of appends plus ~2x that
// again in compaction rewrites — against ~600 GB for a full-rewrite-every-2min snapshot,
// and still nothing on a boat SSD.
//
// To keep RAM/disk bounded at any window, the EMIT rate auto-coarsens so the ring never
// exceeds ~MAX_SAMPLES rows (24 h → 15 s, 30 d → ~52 s). That coarsening used to throw
// readings away; it no longer does. Only the emit rate coarsens, never the poll, so a
// 30-day passage still carries the true min/max within each ~52 s bucket.
//
// All fs is guarded — a missing/corrupt file just means an empty start; appends +
// compactions are serialized so they can't interleave.

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
// The channels whose values WRAP. A compass bearing cannot be averaged or min/max'd
// arithmetically — the mean of 359° and 1° is 180°, the exact opposite of the truth — so
// these keep a plain snapshot of the LAST reading in the interval and never carry a band.
// Everything else is linear and gets both. Same split as the app's ring provider; a
// mistake here would look entirely plausible on screen, which is why the test pins it.
const WRAPPED = new Set(['twd', 'twa', 'awa', 'cog', 'heading', 'wptBrg'])

const wrap360 = (d) => ((d % 360) + 360) % 360
// Stored values are rounded to 3 decimals. Rows now carry a mean plus two extremes per
// channel, so full float noise ("6.430000000000001") would inflate every persisted line
// for precision no instrument has and no chart can draw.
const round3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v)
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
  constructor ({ source, perfSource, sampleSec, pollSec, windowSec, persistFile } = {}) {
    this._source = source
    this._perfSource = perfSource || null
    this._ring = [] // [{ t, ...CHANNELS, lo:{}, hi:{}, n:{}, lat, lon }]
    const win = windowSec || 3600
    this._windowMs = win * 1000
    this._persistFile = persistFile || null
    this._io = Promise.resolve() // serialized fs writes (append/compact never interleave)
    this._appendedSinceCompact = 0
    // auto-coarsen so the ring is bounded (~MAX_SAMPLES rows) regardless of window
    const stepSec = Math.max(sampleSec || 15, Math.ceil(win / MAX_SAMPLES))
    this._stepSec = stepSec
    // TWO CLOCKS. This used to SNAPSHOT BoatState once per stepSec and store point values,
    // which threw away 14 of every 15 readings BEFORE anything could ask a question about
    // them: the gusts were gone before a chart ever saw the data, and no amount of later
    // bucketing could bring them back. Now the state is POLLED at pollSec (~1 s, the rate
    // the boat publishes) into a per-channel sum/count/min/max accumulator, and one row is
    // EMITTED every stepSec carrying the mean plus the true extremes seen inside it.
    //
    // Ring length and emit rate are unchanged, so every existing budget still holds — and
    // MAX_SAMPLES coarsening stops being lossy: a 30-day passage emitting every ~52 s
    // still carries the true min/max within each 52 s, because the poll never coarsened.
    this._pollSec = Math.min(stepSec, Math.max(0.2, pollSec || 1))
    this._resetAcc()

    this._load() // seed from disk (survives restart)
    this._compactSync() // rewrite clean + bounded, synchronously (file exists right at start)
    this._sample() // immediate first row, so a fresh process is not blank for stepSec
    this._pollTimer = setInterval(() => this._poll(), this._pollSec * 1000)
    this._timer = setInterval(() => this._emit(), stepSec * 1000)
    if (this._timer.unref) this._timer.unref()
    if (this._pollTimer.unref) this._pollTimer.unref()
  }

  // --- sampling ---
  _resetAcc () {
    // polls counts readings seen since the last emit. Zero means the telemetry source
    // gave us nothing at all, and we push no row — a gap is the honest record, where a
    // row of nulls would be a claim that we looked and the boat had no data.
    this._acc = { polls: 0, sum: {}, cnt: {}, lo: {}, hi: {}, last: {}, lat: null, lon: null }
  }

  // BoatState -> the flat channel map this ring records. Kept separate from the
  // accumulator so poll and emit share one definition of where each channel comes from.
  _raw (s) {
    const tw = trueWind(s)
    return {
      sog: s.sogKt, cog: s.cogDeg, heading: s.headingDeg, stw: s.stwKt,
      aws: s.awsKt, awa: s.awaDeg, depth: s.depthM,
      tws: tw ? tw.tws : null, twd: tw ? tw.twd : null,
      // Everything below arrived in BoatState with v0.18.6 but was never sampled here,
      // so these instrument cells had a live value and an empty history flyout.
      twa: s.twaDeg, vmg: s.vmgKt,
      seaTemp: s.seaTempC, airTemp: s.airTempC,
      rpmPort: s.rpmPort, rpmStbd: s.rpmStbd,
      // Waypoint channels are legitimately null when no destination is active — the
      // accumulator skips non-finite values and CHANNELS omits empty ones, so the flyout
      // stays blank rather than showing a flat line at zero.
      wptBrg: s.wptBrgDeg, wptDist: s.wptDistNm,
      wptVmg: s.wptVmgKt, wptTtg: s.wptTtgSec,
      perf: this._perfSource ? this._perfSource.getPerf() : null
    }
  }

  _poll () {
    const s = this._source && this._source.getState && this._source.getState()
    if (!s) return
    const raw = this._raw(s)
    const a = this._acc
    a.polls++
    for (const c of CHANNELS) {
      const v = raw[c]
      if (!Number.isFinite(v)) continue
      a.last[c] = v
      if (WRAPPED.has(c)) continue // a bearing has no meaningful mean or extreme
      a.sum[c] = (a.sum[c] || 0) + v
      a.cnt[c] = (a.cnt[c] || 0) + 1
      a.lo[c] = Math.min(a.lo[c] == null ? v : a.lo[c], v)
      a.hi[c] = Math.max(a.hi[c] == null ? v : a.hi[c], v)
    }
    if (Number.isFinite(s.lat)) a.lat = s.lat
    if (Number.isFinite(s.lon)) a.lon = s.lon
  }

  // One row per stepSec: the mean of everything seen since the last emit, plus the true
  // extremes (`lo`/`hi`) and the sample count behind each mean (`n`, needed to weight a
  // later re-bucket). Wrapped channels carry the last reading and appear in none of the
  // three.
  _emit () {
    const a = this._acc
    if (!a.polls) return
    const row = { t: Date.now(), lo: {}, hi: {}, n: {} }
    for (const c of CHANNELS) {
      if (WRAPPED.has(c)) { row[c] = a.last[c] == null ? null : round3(a.last[c]); continue }
      const n = a.cnt[c] || 0
      if (!n) { row[c] = null; continue }
      row[c] = round3(a.sum[c] / n)
      row.lo[c] = round3(a.lo[c])
      row.hi[c] = round3(a.hi[c])
      row.n[c] = n
    }
    row.lat = a.lat == null ? null : a.lat
    row.lon = a.lon == null ? null : a.lon
    this._resetAcc()

    this._ring.push(row)
    const cutoff = Date.now() - this._windowMs
    while (this._ring.length && this._ring[0].t < cutoff) this._ring.shift()
    this._append(row)
  }

  // One poll + one emit, i.e. the old single-shot behaviour. Used for the first row at
  // construction and by the tests, which drive the clocks by hand.
  _sample () {
    this._poll()
    this._emit()
  }

  available () { return true }

  // A trailing window, or an ABSOLUTE range when the caller passes fromMs/toMs — which
  // the app does for the historic trail and for a Trends flyout scrolled back in time.
  // Ignoring those silently returned the most RECENT window instead, so the trail showed
  // the current hour dressed as history rather than failing visibly.
  _window (windowSec, fromMs, toMs) {
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
      // The ring only holds its own retention; asking beyond that yields what exists.
      return this._ring.filter((r) => r.t >= fromMs && r.t <= toMs)
    }
    const cutoff = Date.now() - Math.min(windowSec * 1000, this._windowMs)
    return this._ring.filter((r) => r.t >= cutoff)
  }

  // `series` is the mean line, exactly as before. Two additive extras, both ignorable:
  //   stats -> `bands`, the true per-bucket [t, min, max] under the mean;
  //   chans -> narrow the answer to the channels actually plotted.
  //
  // `everySec` is now HONOURED. It used to be ignored outright, so the history sheet's
  // 24 h pill got raw sample-rate points whatever the pill said. Rows are re-bucketed
  // into everySec windows: means weighted by the sample count behind each row, extremes
  // as min-of-mins / max-of-maxes, wrapped channels taking the last reading. Buckets are
  // labelled at their END, matching the cloud's aggregateWindow(timeSrc: "_stop") — label
  // them at the start and the two providers plot half a bucket apart on the same screen.
  getSeries ({ windowSec, everySec, fromMs, toMs, stats, chans } = {}) {
    const rows = this._window(windowSec, fromMs, toMs)
    const want = chans && chans.length ? new Set(chans) : null
    const step = Math.max(0, Math.round(everySec || 0)) * 1000
    const series = {}
    const bands = {}
    for (const c of CHANNELS) {
      if (want && !want.has(c)) continue
      const wrapped = WRAPPED.has(c)
      // With no `every`, every row is its own point — which is what this endpoint has
      // always returned, and the contract says `series` is unchanged with or without the
      // new params. (Bucketing by r.t instead would merge two rows sharing a millisecond,
      // which never happens in flight but does when a caller drives the clock by hand.)
      const buckets = new Map()
      let seq = 0
      for (const r of rows) {
        const v = r[c]
        if (v == null) continue
        const key = step ? Math.floor(r.t / step) * step : seq++
        let b = buckets.get(key)
        if (!b) buckets.set(key, (b = { t: step ? key + step : r.t, sum: 0, n: 0, lo: Infinity, hi: -Infinity, last: null }))
        b.last = v
        if (wrapped) continue
        // Rows written before v0.29.0 carry no lo/hi/n. Reading them defensively means an
        // append-log from an older version still loads and simply yields a degenerate
        // band (the point value itself) rather than an empty chart or a crash.
        const n = (r.n && r.n[c]) || 1
        b.sum += v * n
        b.n += n
        const lo = (r.lo && r.lo[c] != null) ? r.lo[c] : v
        const hi = (r.hi && r.hi[c] != null) ? r.hi[c] : v
        if (lo < b.lo) b.lo = lo
        if (hi > b.hi) b.hi = hi
      }
      const out = [...buckets.values()].sort((a, b) => a.t - b.t)
      const pts = wrapped
        ? out.map((b) => [b.t, b.last])
        : out.filter((b) => b.n > 0).map((b) => [b.t, round3(b.sum / b.n)])
      if (!pts.length) continue
      series[c] = pts
      // No `|| wrapped` here: the bucket loop above never accumulates a wrapped channel,
      // so `n` stays 0 and the filter below drops it anyway. Keeping the extra condition
      // would be unreachable code that no test can pin — and an unpinnable guard is the
      // kind that quietly stops matching the guard it duplicates.
      if (!stats) continue
      const band = out
        .filter((b) => b.n > 0 && Number.isFinite(b.lo) && Number.isFinite(b.hi))
        .map((b) => [b.t, b.lo, b.hi])
      if (band.length) bands[c] = band
    }
    return stats ? { ok: true, series, bands } : { ok: true, series }
  }

  getTrack ({ windowSec, fromMs, toMs, everySec } = {}) {
    let track = this._window(windowSec, fromMs, toMs)
      .filter((r) => r.lat != null && r.lon != null)
      .map((r) => ({ t: r.t, lat: r.lat, lon: r.lon }))
    // `every` thins the trail for a long span. The ring samples far finer than any chart
    // needs (a 30-day window is ~50k rows), and the app asks for this to keep the line
    // drawable — so honour it rather than shipping every point.
    if (Number.isFinite(everySec) && everySec > 0 && track.length > 1) {
      const step = everySec * 1000
      const out = [track[0]]
      for (const p of track) if (p.t - out[out.length - 1].t >= step) out.push(p)
      const last = track[track.length - 1]
      if (out[out.length - 1].t !== last.t) out.push(last) // never lose the newest fix
      track = out
    }
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
    clearInterval(this._pollTimer)
    this._compact() // final flush of the current ring
  }
}

module.exports = { RingHistoryProvider, MAX_SAMPLES, CHANNELS, WRAPPED }
