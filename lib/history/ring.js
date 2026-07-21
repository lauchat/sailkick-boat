'use strict'

// DB-less history provider — a rolling ~1 h ring sampled from the live telemetry
// BoatState (the same state that feeds /ws/telemetry). This is the edge path when
// there's no local InfluxDB (e.g. SignalK on a Victron GX / Venus OS). Fully
// offline, tiny memory. Serves the SAME series/track contract as the InfluxDB
// provider. Ported verbatim from the sailkick app (server/history/ring-provider.js);
// STW isn't in BoatState so it's simply absent, and TWS/TWD are derived from
// apparent wind + boat motion (as the ribbon does).

const DEG = Math.PI / 180
const wrap360 = (d) => ((d % 360) + 360) % 360

// True wind (TWS kt, TWD ° the wind blows FROM) from apparent + motion over ground.
function trueWind (s) {
  if (!Number.isFinite(s.awsKt) || !Number.isFinite(s.awaDeg) || !Number.isFinite(s.headingDeg)) return null
  const a = s.awaDeg * DEG
  const x = s.awsKt * Math.cos(a) - (s.sogKt || 0); const y = s.awsKt * Math.sin(a)
  return { tws: Math.hypot(x, y), twd: wrap360(s.headingDeg + Math.atan2(y, x) / DEG) }
}

class RingHistoryProvider {
  constructor ({ source, sampleSec, windowSec } = {}) {
    this._source = source
    this._ring = [] // [{ t, sog, cog, heading, aws, awa, depth, tws, twd, lat, lon }]
    this._windowMs = (windowSec || 3600) * 1000
    const stepMs = (sampleSec || 15) * 1000
    this._sample()
    this._timer = setInterval(() => this._sample(), stepMs)
    if (this._timer.unref) this._timer.unref()
  }

  _sample () {
    const s = this._source && this._source.getState && this._source.getState()
    if (!s) return
    const tw = trueWind(s)
    const num = (v) => (Number.isFinite(v) ? v : null)
    this._ring.push({
      t: Date.now(),
      sog: num(s.sogKt), cog: num(s.cogDeg), heading: num(s.headingDeg),
      aws: num(s.awsKt), awa: num(s.awaDeg), depth: num(s.depthM),
      tws: tw ? tw.tws : null, twd: tw ? tw.twd : null,
      lat: num(s.lat), lon: num(s.lon)
    })
    const cutoff = Date.now() - this._windowMs
    while (this._ring.length && this._ring[0].t < cutoff) this._ring.shift()
  }

  available () { return true } // always usable; returns whatever it has collected

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

  destroy () { clearInterval(this._timer) }
}

module.exports = { RingHistoryProvider }
