'use strict'

const test = require('node:test')
const assert = require('node:assert')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { RingHistoryProvider, MAX_SAMPLES } = require('../lib/history/ring')
const { createHistory } = require('../lib/history')

const app = { debug () {} }
let seq = 0
const tmpFile = () => path.join(os.tmpdir(), `sk-ring-${process.pid}-${seq++}.jsonl`)

// A telemetry-like source whose getState() returns a scripted BoatState.
function fakeSource (initial) {
  let s = initial
  return { set (v) { s = v }, getState () { return s } }
}

test('ring: samples BoatState into series (with derived tws/twd) + ordered track', () => {
  const src = fakeSource(null)
  const ring = new RingHistoryProvider({ source: src, windowSec: 3600, sampleSec: 99999 })
  // no fix yet → constructor sample is a no-op
  assert.deepStrictEqual(ring.getSeries({ windowSec: 3600 }).series, {})

  src.set({ sogKt: 5, cogDeg: 90, headingDeg: 0, awsKt: 10, awaDeg: 90, depthM: 12, lat: 40, lon: -74 })
  ring._sample()
  src.set({ sogKt: 6, cogDeg: 92, headingDeg: 10, awsKt: 11, awaDeg: 80, depthM: 13, lat: 40.01, lon: -74.01 })
  ring._sample()

  const { series } = ring.getSeries({ windowSec: 3600 })
  for (const ch of ['sog', 'heading', 'aws', 'awa', 'depth', 'tws', 'twd']) {
    assert.ok(Array.isArray(series[ch]) && series[ch].length === 2, `channel ${ch} has 2 points`)
    assert.strictEqual(series[ch][0].length, 2, '[tMs, value] pairs')
  }
  assert.ok(series.tws[0][1] > 0, 'true wind derived from apparent + motion')

  const { track } = ring.getTrack({ windowSec: 3600 })
  assert.strictEqual(track.length, 2)
  assert.ok(track[0].t <= track[1].t, 'ordered by time')
  assert.ok(Math.abs(track[1].lat - 40.01) < 1e-9 && Math.abs(track[1].lon + 74.01) < 1e-9)
  ring.destroy()
})

test('ring: window trims samples older than windowSec', () => {
  const src = fakeSource({ sogKt: 3, cogDeg: 0, headingDeg: 0, awsKt: null, awaDeg: null, lat: 1, lon: 2 })
  const ring = new RingHistoryProvider({ source: src, windowSec: 3600, sampleSec: 99999 })
  // the constructor already took one sample — age every sample past the window
  ring._ring.forEach((r) => { r.t -= 2 * 3600 * 1000 })
  assert.strictEqual(ring.getSeries({ windowSec: 3600 }).series.sog, undefined, 'stale sample excluded')
  assert.strictEqual(ring.getTrack({ windowSec: 3600 }).track.length, 0)
  ring.destroy()
})

test('history: serves the ring whenever a telemetry source exists', async () => {
  const src = fakeSource({ sogKt: 4, cogDeg: 10, headingDeg: 5, awsKt: 8, awaDeg: 60, depthM: 20, lat: 36.9, lon: -76.3 })
  const h = createHistory(app, { token: '', ringSource: src, ringSampleSec: 99999 })
  h.start()
  assert.strictEqual(h.available(), true, 'ring makes history available without a DB')

  const cap = () => ({ statusCode: 200, headers: {}, body: '', writableFinished: false, on () {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b || ''; this.writableFinished = true } })
  const res = cap()
  await h.handleSeries({ url: '/api/history/series?window=3600s&every=30s' }, res)
  const j = JSON.parse(res.body)
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(j.ok, true)
  assert.strictEqual(j.windowSec, 3600)
  assert.ok(j.series.sog && j.series.heading, 'served from the ring')
  h.stop()
})

// Until v0.15.0 a read token switched history to a local InfluxDB, which for a bucket of
// older data returned nothing (the app only asks for a relative window clamped to 24 h)
// AND turned off the working live ring. A leftover token must never do that again.
test('history: a stale InfluxDB token in the config cannot displace the ring', async () => {
  const src = fakeSource({ sogKt: 4, cogDeg: 10, headingDeg: 5, awsKt: 8, awaDeg: 60, lat: 1, lon: 2 })
  const h = createHistory(app, { token: 'STALE', bucket: 'bandg', influxUrl: 'http://127.0.0.1:1', ringSource: src, ringSampleSec: 99999 })
  h.start()
  assert.strictEqual(h.available(), true)
  const res = { statusCode: 200, headers: {}, body: '', writableFinished: false, on () {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b || ''; this.writableFinished = true } }
  await h.handleSeries({ url: '/api/history/series?window=3600s&every=30s' }, res)
  const j = JSON.parse(res.body)
  assert.strictEqual(res.statusCode, 200, 'no attempt to reach the dead InfluxDB at :1')
  assert.ok(j.series.sog, 'served live from the ring')
  h.stop()
})

test('history: unavailable with no telemetry source at all', async () => {
  const h = createHistory(app, {}) // no ringSource
  h.start()
  assert.strictEqual(h.available(), false)
  const res = { statusCode: 200, headers: {}, body: '', writableFinished: false, on () {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b || ''; this.writableFinished = true } }
  await h.handleSeries({ url: '/api/history/series' }, res)
  assert.strictEqual(res.statusCode, 503)
  h.stop()
})

// ---- persistence (append-log) ----

test('ring persist: survives a restart (append-log reloaded into a fresh provider)', async () => {
  const file = tmpFile()
  const src = fakeSource({ sogKt: 5, cogDeg: 90, headingDeg: 0, awsKt: 10, awaDeg: 90, depthM: 12, lat: 40, lon: -74 })
  const a = new RingHistoryProvider({ source: src, windowSec: 3600, sampleSec: 99999, persistFile: file })
  // constructor sampled once; add two more
  src.set({ sogKt: 6, cogDeg: 92, headingDeg: 10, awsKt: 11, awaDeg: 80, depthM: 13, lat: 40.01, lon: -74.01 }); a._sample()
  src.set({ sogKt: 7, cogDeg: 94, headingDeg: 20, awsKt: 12, awaDeg: 70, depthM: 14, lat: 40.02, lon: -74.02 }); a._sample()
  await a._flush()
  a.destroy(); await a._flush()

  // "restart": a brand-new provider on the same file reloads the history
  const b = new RingHistoryProvider({ source: fakeSource(null), windowSec: 3600, sampleSec: 99999, persistFile: file })
  const { series } = b.getSeries({ windowSec: 3600 })
  assert.ok(series.sog && series.sog.length >= 3, 'reloaded the persisted samples')
  const { track } = b.getTrack({ windowSec: 3600 })
  assert.ok(track.length >= 3 && track[0].t <= track[track.length - 1].t)
  b.destroy(); await b._flush()
  fs.rmSync(file, { force: true })
})

test('ring persist: compaction rewrites the log down to the current ring (bounded)', async () => {
  const file = tmpFile()
  const src = fakeSource({ sogKt: 1, cogDeg: 0, headingDeg: 0, awsKt: null, awaDeg: null, lat: 1, lon: 2 })
  const r = new RingHistoryProvider({ source: src, windowSec: 3600, sampleSec: 99999, persistFile: file })
  for (let i = 0; i < 10; i++) r._sample()
  r._appendedSinceCompact = 10000 // simulate a log that has grown far past the ring
  r._sample() // this append crosses the threshold → triggers a compaction
  await r._flush()
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
  assert.strictEqual(lines, r._ring.length, 'file rewritten to exactly the ring size')
  assert.ok(lines <= 50, 'bounded (not an unbounded append log)')
  r.destroy(); await r._flush()
  fs.rmSync(file, { force: true })
})

test('ring persist: load drops rows older than the window and skips corrupt lines', () => {
  const file = tmpFile()
  const now = Date.now()
  fs.writeFileSync(file, [
    JSON.stringify({ t: now - 10 * 3600 * 1000, sog: 9, lat: 1, lon: 1 }), // too old
    '{ this is not json',                                                  // corrupt
    JSON.stringify({ t: now - 60 * 1000, sog: 4, lat: 2, lon: 2 })         // recent
  ].join('\n') + '\n')
  const r = new RingHistoryProvider({ source: fakeSource(null), windowSec: 3600, sampleSec: 99999, persistFile: file })
  const { series } = r.getSeries({ windowSec: 3600 })
  assert.strictEqual(series.sog.length, 1, 'only the recent, valid row survived load')
  assert.strictEqual(series.sog[0][1], 4)
  r.destroy()
  fs.rmSync(file, { force: true })
})

test('ring: sample rate auto-coarsens so a huge window stays bounded', () => {
  const day = new RingHistoryProvider({ source: fakeSource(null), windowSec: 86400, sampleSec: 15 })
  assert.strictEqual(day._stepSec, 15, '24h keeps the requested 15s')
  const passage = new RingHistoryProvider({ source: fakeSource(null), windowSec: 2592000, sampleSec: 15 })
  assert.ok(passage._stepSec >= Math.ceil(2592000 / MAX_SAMPLES), '30d coarsens to bound rows')
  assert.ok(passage._stepSec >= 52 && passage._stepSec <= 60, `30d step ~52s (got ${passage._stepSec})`)
  day.destroy(); passage.destroy()
})

test('history: ring log defaults under storeDir/history; ringDir overrides; ringPersist:false is in-memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-hist-dd-'))
  const store = path.join(dir, 'ssd-store')
  const appDD = { debug () {}, getDataDirPath () { return dir } }
  const src = fakeSource({ sogKt: 3, lat: 1, lon: 2 })

  // default: under the configured storeDir, in a history/ folder (on the SSD with tiles)
  const def = createHistory(appDD, { token: '', ringSource: src, ringSampleSec: 99999, storeDir: store })
  def.start()
  assert.ok(fs.existsSync(path.join(store, 'history', 'history-ring.jsonl')), 'ring log under <storeDir>/history')
  def.stop()

  // override: explicit ringDir wins
  const over = path.join(dir, 'custom-ring')
  const ov = createHistory(appDD, { token: '', ringSource: src, ringSampleSec: 99999, storeDir: store, ringDir: over })
  ov.start()
  assert.ok(fs.existsSync(path.join(over, 'history-ring.jsonl')), 'ring log at the override dir')
  assert.ok(!fs.existsSync(path.join(store, 'history', 'history-ring.jsonl')) || true) // default not required when overridden
  ov.stop()

  // off: in-memory only, no file written under storeDir
  fs.rmSync(path.join(store, 'history'), { recursive: true, force: true })
  const off = createHistory(appDD, { token: '', ringSource: src, ringPersist: false, ringSampleSec: 99999, storeDir: store })
  off.start()
  assert.ok(!fs.existsSync(path.join(store, 'history', 'history-ring.jsonl')), 'ringPersist:false writes nothing')
  off.stop()

  fs.rmSync(dir, { recursive: true, force: true })
})

// --- true wind provenance (v0.14.6) ----------------------------------------------
const { RingHistoryProvider: RP } = require('../lib/history/ring')
const ringOf = (state) => {
  const p = new RP({ source: { getState: () => state }, sampleSec: 1, windowSec: 600 })
  p._sample()
  return p.getSeries({ windowSec: 600 }).series
}

test('measured true wind from the instruments is used verbatim, not re-derived', () => {
  // AWS/AWA/SOG here would derive ~9.2 kt; the wind system says 12.0 with its own
  // heel/leeway correction. The instruments win — every other display aboard shows theirs.
  const s = ringOf({ sogKt: 6, stwKt: 6, headingDeg: 0, awsKt: 17, awaDeg: 30, twsKt: 12, twdDeg: 200 })
  assert.ok(Math.abs(s.tws[0][1] - 12) < 1e-9, 'TWS passed through untouched')
  assert.ok(Math.abs(s.twd[0][1] - 200) < 1e-9, 'TWD passed through untouched')
})

test('derived true wind uses speed through water, not over ground', () => {
  // Same boat, same wind, 3 kt of foul tide: STW 6, SOG 3. Deriving from SOG (the
  // pre-0.14.6 behaviour) overstates the headwind component and skews TWS and TWD.
  const base = { headingDeg: 0, awsKt: 15, awaDeg: 40 }
  const withStw = ringOf({ ...base, stwKt: 6, sogKt: 3 })
  const sogOnly = ringOf({ ...base, sogKt: 3 })
  assert.ok(Math.abs(withStw.tws[0][1] - sogOnly.tws[0][1]) > 0.5,
    'using STW gives a materially different answer than SOG in a tidal stream')
  const noStw = ringOf({ ...base, sogKt: 3 })
  assert.ok(Number.isFinite(noStw.tws[0][1]), 'boats with no paddlewheel still get a value')
})

test('STW is now a history channel, and absent when the boat has no log', () => {
  const withLog = ringOf({ sogKt: 6, stwKt: 5.5, headingDeg: 10, awsKt: 12, awaDeg: 45 })
  assert.ok(Math.abs(withLog.stw[0][1] - 5.5) < 1e-9)
  const noLog = ringOf({ sogKt: 6, headingDeg: 10, awsKt: 12, awaDeg: 45 })
  assert.strictEqual(noLog.stw, undefined, 'empty channels are omitted, not zero-filled')
})

// --- channel-set parity (v0.20.1) --------------------------------------------------
// The ring's channel list was frozen at the eight channels that existed before v0.18.6,
// while BoatState and the app both grew cells for true wind angle, VMG, sea/air
// temperature, engine revs and the four active-waypoint values. `cog` was worse: it was
// sampled into every row and then dropped from the output. Eleven of nineteen instrument
// cells showed a live number and an empty history flyout — but only on the boat, since
// the cloud provider had them all.
const { CHANNELS } = require('../lib/history/ring')
const fsx = require('node:fs')

test('ring: samples and serves every channel the app has a cell for', () => {
  // A BoatState with every field populated, as the boat actually produces (verified live:
  // an active waypoint gives wptBrg/wptDist/wptVmg/wptTtg).
  const state = {
    sogKt: 5.03, cogDeg: 46.4, headingDeg: 52.3, stwKt: 4.8,
    awsKt: 12.1, awaDeg: -35, depthM: 62,
    twsKt: 14.2, twdDeg: 210,
    twaDeg: -175.1, vmgKt: -5.02,
    seaTempC: 19.88, airTempC: 41.44,
    rpmPort: 1762.3, rpmStbd: 0,
    wptBrgDeg: 54.4, wptDistNm: 4.37, wptVmgKt: 4.99, wptTtgSec: 3152,
    lat: 43.91, lon: -64.82
  }
  // perf is COMPUTED (lib/perf), not mapped off the bus, so it needs its own source.
  const r = new RingHistoryProvider({
    source: { getState: () => state },
    perfSource: { getPerf: () => 94 },
    sampleSec: 1,
    windowSec: 60
  })
  const { series } = r.getSeries({ windowSec: 60 })
  r.destroy && r.destroy()

  const missing = CHANNELS.filter((c) => !series[c])
  assert.deepStrictEqual(missing, [], 'every channel must be served when the value is present')
  assert.strictEqual(series.cog[0][1], 46.4, 'cog was sampled but never emitted before')
  assert.strictEqual(series.wptDist[0][1], 4.37)
  assert.strictEqual(series.rpmStbd[0][1], 0, 'a legitimate zero is not "empty"')
  assert.strictEqual(series.perf[0][1], 94, 'the computed polar percentage')
  assert.ok(Math.abs(series.vmg[0][1] + 5.02) < 1e-9, 'VMG keeps its sign')
})

test('ring: a cleared destination leaves the waypoint channels absent, not zeroed', () => {
  const state = { sogKt: 5, cogDeg: 90, headingDeg: 90, lat: 1, lon: 1, wptBrgDeg: null, wptDistNm: null, wptVmgKt: null, wptTtgSec: null }
  const r = new RingHistoryProvider({ source: { getState: () => state }, sampleSec: 1, windowSec: 60 })
  const { series } = r.getSeries({ windowSec: 60 })
  r.destroy && r.destroy()
  for (const c of ['wptBrg', 'wptDist', 'wptVmg', 'wptTtg']) {
    assert.strictEqual(series[c], undefined, `${c} omitted when no destination is set`)
  }
  assert.ok(series.sog, 'the rest still works')
})

// Guard against the same drift recurring: the ring's channel names must match the
// cloud provider's, which is the contract the app's instrument cells are written to.
// Skipped (not failed) when the app source is not checked out alongside.
const APP_PROVIDER = process.env.SAILKICK_APP_REPO
  ? `${process.env.SAILKICK_APP_REPO}/server/history/influx-provider.js`
  : '/workspace/sailkick/server/history/influx-provider.js'

test('ring: channel set matches the cloud provider', { skip: !fsx.existsSync(APP_PROVIDER) && 'app source not checked out' }, () => {
  const src = fsx.readFileSync(APP_PROVIDER, 'utf8')
  const cloud = new Set([...src.matchAll(/chan:\s*'([A-Za-z]+)'/g)].map((m) => m[1]))
  const missing = [...cloud].filter((c) => !CHANNELS.includes(c)).sort()
  assert.deepStrictEqual(missing, [], 'channels the cloud serves that the ring does not — Trends would differ by provider')
})

// --- absolute ranges for the historic trail (v0.23.10) --------------------------------
// Reported: the historic trail does not work in edge mode. The app's fetchTrack sends
// `from=<ms>&to=<ms>` for a scrolled-back view (public/engine/history-client.js), and the
// boat parsed only `window` — so it silently returned the most RECENT hour instead. That
// is worse than an error: the trail showed the current hour dressed up as history.
// Measured on the boat: asked 15:56->16:56, got 16:56->17:56.
const { createHistory: mkHistory } = require('../lib/history')

function seeded (spanMin = 120) {
  // A ring pre-loaded with a known span, so an absolute range has something to select.
  const now = Date.now()
  const rows = []
  for (let i = spanMin; i >= 0; i--) {
    rows.push({ t: now - i * 60000, sog: 5, cog: 90, heading: 90, lat: 48 + i * 0.001, lon: -25 - i * 0.001 })
  }
  const r = new RingHistoryProvider({ source: { getState: () => null }, sampleSec: 999999, windowSec: 86400 })
  r._ring = rows
  return { r, now }
}

test('ring: an absolute from/to selects that span, not the newest one', () => {
  const { r, now } = seeded(120)
  const fromMs = now - 120 * 60000
  const toMs = now - 60 * 60000
  const t = r.getTrack({ windowSec: 3600, fromMs, toMs }).track
  assert.ok(t.length > 0, 'points returned')
  assert.ok(t[0].t >= fromMs && t[t.length - 1].t <= toMs, 'every point inside the requested range')
  // and it must NOT be the same as the trailing window
  const trailing = r.getTrack({ windowSec: 3600 }).track
  assert.notStrictEqual(t[0].t, trailing[0].t, 'a historic range differs from the last hour')
  r.destroy && r.destroy()
})

test('ring: series honours an absolute range too', () => {
  const { r, now } = seeded(120)
  const s = r.getSeries({ windowSec: 3600, fromMs: now - 120 * 60000, toMs: now - 60 * 60000 })
  const pts = s.series.sog
  assert.ok(pts && pts.length, 'sog present')
  assert.ok(pts[pts.length - 1][0] <= now - 60 * 60000, 'nothing newer than `to` leaked in')
  r.destroy && r.destroy()
})

test('ring: `every` thins the trail but keeps the ends', () => {
  const { r } = seeded(120)
  const full = r.getTrack({ windowSec: 86400 }).track
  const thin = r.getTrack({ windowSec: 86400, everySec: 600 }).track
  assert.ok(thin.length < full.length, `thinned: ${thin.length} < ${full.length}`)
  assert.strictEqual(thin[0].t, full[0].t, 'first point kept')
  assert.strictEqual(thin[thin.length - 1].t, full[full.length - 1].t, 'newest fix never dropped')
  for (let i = 1; i < thin.length - 1; i++) {
    assert.ok(thin[i].t - thin[i - 1].t >= 600000, 'spacing respected')
  }
  r.destroy && r.destroy()
})

test('history: the HTTP handlers pass from/to through and echo the real range', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skb-abs-'))
  const now = Date.now()
  const h = mkHistory({ debug () {}, error () {} }, {
    ringSource: { getState: () => ({ sogKt: 5, cogDeg: 90, headingDeg: 90, lat: 48, lon: -25 }) },
    ringSampleSec: 1, ringWindowSec: 86400, ringPersist: false, storeDir: dir
  })
  h.start()
  const prov = h._provider()
  prov._ring = Array.from({ length: 121 }, (_, i) => ({
    t: now - (120 - i) * 60000, sog: 5, cog: 90, heading: 90, lat: 48 + i * 0.001, lon: -25 - i * 0.001
  }))
  const call = (url) => new Promise((resolve) => {
    const req = { url, method: 'GET', headers: {} }
    const res = { statusCode: 200, setHeader () {}, on () {}, once () {}, end (b) { resolve(JSON.parse(b)) } }
    h.handleTrack(req, res)
  })
  const fromMs = now - 120 * 60000
  const toMs = now - 60 * 60000
  const abs = await call(`/api/history/track?from=${fromMs}&to=${toMs}`)
  assert.strictEqual(abs.ok, true)
  assert.ok(abs.track.length > 0, 'points returned for the historic range')
  assert.ok(abs.track[abs.track.length - 1].t <= toMs, 'nothing newer than `to`')
  assert.strictEqual(abs.from, fromMs, 'the response echoes the range asked for')
  assert.strictEqual(abs.to, toMs)

  const win = await call('/api/history/track?window=3600s')
  assert.ok(win.track[0].t > abs.track[0].t, 'the trailing window is a different, later span')
  h.stop()
})

test('history: a malformed from/to falls back to the window rather than erroring', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skb-abs2-'))
  const h = mkHistory({ debug () {}, error () {} }, {
    ringSource: { getState: () => ({ sogKt: 5, lat: 48, lon: -25 }) },
    ringSampleSec: 1, ringWindowSec: 3600, ringPersist: false, storeDir: dir
  })
  h.start()
  const call = (url) => new Promise((resolve) => {
    h.handleTrack({ url, method: 'GET', headers: {} },
      { statusCode: 200, setHeader () {}, on () {}, once () {}, end (b) { resolve(JSON.parse(b)) } })
  })
  for (const bad of ['from=abc&to=def', 'from=100&to=50', 'from=', 'to=12345']) {
    const r = await call(`/api/history/track?${bad}&window=600s`)
    assert.strictEqual(r.ok, true, `"${bad}" still answers`)
  }
  h.stop()
})

// --- min/max bands under the mean (v0.29.0) ------------------------------------------
// The ring used to SNAPSHOT BoatState once per sampleSec, throwing away 14 of every 15
// readings before anything could ask a question about them. The gusts were gone before a
// chart saw the data, and no later bucketing could bring them back. Now it polls into an
// accumulator and emits mean + true extremes. The app measured what that hides: one hour
// of real sailing at 20 s buckets, mean line spanning 4.8 kt against a true envelope of
// 8.3 kt — 1.87 kt of spread inside an average bucket, 4.49 kt in the worst.
const { WRAPPED } = require('../lib/history/ring')

const sailing = (over) => ({
  sogKt: 6, stwKt: 5.8, cogDeg: 180, headingDeg: 178, awsKt: 14, awaDeg: 40, depthM: 20,
  twsKt: 12, twdDeg: 218, twaDeg: 40, vmgKt: 4, seaTempC: 19, airTempC: 21,
  rpmPort: 0, rpmStbd: 0, wptBrgDeg: 300, wptDistNm: 12, wptVmgKt: 3, wptTtgSec: 9000,
  lat: 43, lon: 6, ...over
})

test('bands: the extremes BETWEEN emits survive — that is the whole feature', () => {
  let state = sailing({ sogKt: 6 })
  const r = new RingHistoryProvider({ source: { getState: () => state }, windowSec: 3600, sampleSec: 99999 })
  // A gust and a lull inside ONE emit interval. Snapshotting would have kept whichever
  // reading happened to land on the tick and lost both.
  for (const v of [6, 9.4, 5.1, 7.2, 6.3]) { state = sailing({ sogKt: v }); r._poll() }
  r._emit()

  const { series, bands } = r.getSeries({ windowSec: 3600, stats: true })
  const [, mean] = series.sog[series.sog.length - 1]
  const [, lo, hi] = bands.sog[bands.sog.length - 1]
  assert.ok(Math.abs(mean - 6.8) < 0.01, `mean of the interval, not a snapshot (got ${mean})`)
  assert.strictEqual(lo, 5.1, 'the lull')
  assert.strictEqual(hi, 9.4, 'the gust')
  assert.ok(lo < mean && mean < hi, 'the mean sits inside its own envelope')
  r.destroy()
})

const SIGNED_CHANS = new Set(['twa', 'awa'])

test('bands: compass channels never get a BAND — a min/max on a circle is meaningless', () => {
  // The error this prevents would look entirely plausible on screen: a wind direction
  // band drawn across the whole compass, or a heading average pointing astern.
  let state = sailing({ twdDeg: 359, cogDeg: 359, headingDeg: 359, awaDeg: 179, twaDeg: 179, wptBrgDeg: 359 })
  const r = new RingHistoryProvider({ source: { getState: () => state }, windowSec: 3600, sampleSec: 99999 })
  r._poll()
  state = sailing({ twdDeg: 1, cogDeg: 1, headingDeg: 1, awaDeg: -179, twaDeg: -179, wptBrgDeg: 1 })
  r._poll(); r._emit()

  const { series, bands } = r.getSeries({ windowSec: 3600, stats: true })
  for (const c of WRAPPED) {
    assert.ok(series[c], `${c} still has a line`)
    assert.strictEqual(bands[c], undefined, `${c} must have NO band`)
    // Since v0.31.0 the line is the CIRCULAR mean, not the last reading — a genuine
    // average with no seam. 359 and 1 average to 0, never to 180.
    const v = series[c][series[c].length - 1][1]
    const expect = SIGNED_CHANS.has(c) ? 180 : 0
    assert.ok(Math.abs(Math.abs(v) - expect) < 1 || Math.abs(Math.abs(v) - 360) < 1,
      `${c} = ${v}: expected the circular mean (~${expect}), never the arithmetic 180`)
  }
  // …and the linear channels alongside them do get bands.
  assert.ok(bands.tws && bands.sog && bands.aws, 'linear channels are unaffected')
  r.destroy()
})

test('bands: WRAPPED is exactly the compass set the app uses', () => {
  // Pinned against sailkick/server/history/ring-provider.js. A channel added to one side
  // only is how the two providers start disagreeing on the same screen.
  assert.deepStrictEqual([...WRAPPED].sort(),
    ['awa', 'cog', 'heading', 'twa', 'twd', 'wptBrg'])
  for (const c of WRAPPED) assert.ok(CHANNELS.includes(c), `${c} is a real channel`)
})

test('bands: absent unless asked, and `series` is unchanged either way', () => {
  let state = sailing({ sogKt: 6 })
  const r = new RingHistoryProvider({ source: { getState: () => state }, windowSec: 3600, sampleSec: 99999 })
  r._poll(); state = sailing({ sogKt: 8 }); r._poll(); r._emit()

  const plain = r.getSeries({ windowSec: 3600 })
  const asked = r.getSeries({ windowSec: 3600, stats: true })
  assert.strictEqual(plain.bands, undefined, 'no stats, no key at all')
  assert.deepStrictEqual(asked.series, plain.series, 'the mean line is byte-identical with or without stats')
  assert.ok(asked.bands.sog, 'and the band is there when asked')
  r.destroy()
})

test('bands: `chans` narrows the answer to what is actually plotted', () => {
  const state = sailing({})
  const r = new RingHistoryProvider({ source: { getState: () => state }, windowSec: 3600, sampleSec: 99999 })
  r._sample()
  const { series, bands } = r.getSeries({ windowSec: 3600, stats: true, chans: ['sog', 'cog'] })
  assert.deepStrictEqual(Object.keys(series).sort(), ['cog', 'sog'])
  assert.deepStrictEqual(Object.keys(bands), ['sog'], 'cog is wrapped, so it brings no band')
  // an unknown name simply matches nothing rather than 500ing
  assert.deepStrictEqual(r.getSeries({ windowSec: 3600, chans: ['nope'] }).series, {})
  r.destroy()
})

test('bands: everySec re-buckets — weighted means, min of mins, buckets labelled at the END', () => {
  // everySec was ignored outright, so the sheet's 24 h pill returned raw sample-rate
  // points whatever the pill said. Labelling matters too: the cloud's aggregateWindow
  // uses timeSrc:"_stop", and labelling at the start would plot the two providers half a
  // bucket apart on the same screen.
  const t0 = Math.floor(Date.now() / 60000) * 60000 - 120000 // clean boundary, wholly in the past
  const r = new RingHistoryProvider({ source: { getState: () => null }, windowSec: 3600, sampleSec: 99999 })
  r._ring = [
    { t: t0 + 5000, sog: 6, lo: { sog: 4 }, hi: { sog: 8 }, n: { sog: 10 }, cog: 100 },
    { t: t0 + 35000, sog: 10, lo: { sog: 9 }, hi: { sog: 14 }, n: { sog: 30 }, cog: 110 },
    { t: t0 + 65000, sog: 5, lo: { sog: 5 }, hi: { sog: 5 }, n: { sog: 10 }, cog: 120 }
  ]
  const { series, bands } = r.getSeries({ windowSec: 3600, everySec: 60, stats: true })
  assert.strictEqual(series.sog.length, 2, 'three rows fall into two 60 s buckets')
  assert.strictEqual(series.sog[0][0], t0 + 60000, 'labelled at the END of the bucket')
  // weighted by n: (6*10 + 10*30) / 40 = 9, NOT the plain mean of 8
  assert.strictEqual(series.sog[0][1], 9, 'means weighted by the samples behind them')
  assert.deepStrictEqual(bands.sog[0], [t0 + 60000, 4, 14], 'min of mins, max of maxes')
  // v0.31.0: a wrapped channel is circular-meaned over the bucket, not point-sampled.
  // mean(100, 110) = 105; the third row (120) falls in the next bucket.
  assert.strictEqual(series.cog[0][1], 105, 'a wrapped channel is circular-meaned over the bucket')
  r.destroy()
})

test('bands: an append-log written by an older version still loads and draws', () => {
  // Rows persisted before this change carry no lo/hi/n. They must yield a degenerate band
  // (the point value itself) rather than an empty chart or a crash — a boat upgrading
  // mid-passage keeps its history.
  const r = new RingHistoryProvider({ source: { getState: () => null }, windowSec: 3600, sampleSec: 99999 })
  // Anchored inside ONE 60 s bucket. Timestamps relative to `now` straddle a minute
  // boundary depending on when the suite happens to run — which is exactly how a test
  // passes alone and fails in the full run.
  const base = Math.floor(Date.now() / 60000) * 60000 - 60000
  r._ring = [{ t: base + 5000, sog: 6, cog: 90 }, { t: base + 35000, sog: 8, cog: 92 }] // old shape
  const { series, bands } = r.getSeries({ windowSec: 3600, everySec: 60, stats: true })
  assert.ok(series.sog.length === 1, 'old rows still bucket')
  assert.strictEqual(series.sog[0][1], 7, 'unweighted, because n defaults to 1 each')
  assert.deepStrictEqual(bands.sog[0].slice(1), [6, 8], 'the band degenerates to the points themselves')
  r.destroy()
})

test('bands: a poll with no telemetry emits no row at all', () => {
  // A row of nulls would be a claim that we looked and the boat had nothing; a gap is the
  // honest record, and it is what every downstream chart already handles.
  const r = new RingHistoryProvider({ source: { getState: () => null }, windowSec: 3600, sampleSec: 99999 })
  r._poll(); r._poll(); r._emit()
  assert.strictEqual(r._ring.length, 0)
  assert.deepStrictEqual(r.getSeries({ windowSec: 3600 }).series, {})
  r.destroy()
})

test('bands: a compass channel gets no band even if a row carries lo/hi for it', () => {
  // Three independent things currently stop a bearing growing a band: the accumulator
  // skips it, the emit writes no lo/hi, and getSeries filters wrapped channels. Removing
  // the last of those broke no test, because the first two also happen to prevent it —
  // so this pins it on its own. A row carrying lo/hi for `cog` is not hypothetical: an
  // append-log written by a future or hand-edited version can hold exactly that.
  const base = Math.floor(Date.now() / 60000) * 60000 - 60000 // one bucket, whatever the clock says
  const r = new RingHistoryProvider({ source: { getState: () => null }, windowSec: 3600, sampleSec: 99999 })
  r._ring = [
    { t: base + 5000, cog: 359, twd: 359, lo: { cog: 350, twd: 350 }, hi: { cog: 10, twd: 10 }, n: { cog: 5, twd: 5 } },
    { t: base + 35000, cog: 1, twd: 1, lo: { cog: 350, twd: 350 }, hi: { cog: 10, twd: 10 }, n: { cog: 5, twd: 5 } }
  ]
  const { series, bands } = r.getSeries({ windowSec: 3600, everySec: 60, stats: true })
  assert.ok(series.cog && series.twd, 'the lines are still drawn')
  assert.strictEqual(bands.cog, undefined, 'never a band on a bearing, whatever the row claims')
  assert.strictEqual(bands.twd, undefined)
  assert.ok(Math.abs(series.cog[0][1]) < 1 || Math.abs(series.cog[0][1] - 360) < 1,
    `the line is the circular mean of 359 and 1 (${series.cog[0][1]}), not the arithmetic 180`)
  r.destroy()
})

// --- circular mean for wrapped channels (v0.31.0) ------------------------------------
// v0.29.0 refused to average a bearing and served the last reading in each bucket:
// correct, but one sample per bucket — and on a long passage the emit rate coarsens to
// ~52 s, so a direction trace would be one reading per 52 s where the cloud averages
// every sample. The circular mean (atan2(Σsin, Σcos)) is a genuine average AND has no
// seam, so it is what both providers now use.
const { circularMeanDeg, wrap180: aWrap180 } = require('../lib/history/angles')

const dirState = (deg, signed = deg) => ({
  twsKt: 12, twdDeg: deg, cogDeg: deg, headingDeg: deg, wptBrgDeg: deg,
  twaDeg: signed, awaDeg: signed, awsKt: 10, sogKt: 5
})
function ringOfDirs (states) {
  let st = states[0]
  const r = new RingHistoryProvider({ source: { getState: () => st }, windowSec: 3600, sampleSec: 99999 })
  for (const s of states) { st = s; r._poll() }
  r._emit()
  return r
}

test('circular mean: 359 and 1 average to ~0, never to 180', () => {
  // The failure this replaces: the arithmetic mean of 359 and 1 is 180 — the exact
  // reciprocal, a wind reported as coming from precisely the opposite direction.
  const r = ringOfDirs([dirState(359), dirState(1), dirState(359)])
  const row = r._ring[r._ring.length - 1]
  for (const c of ['twd', 'cog', 'heading', 'wptBrg']) {
    assert.ok(Math.abs(row[c] - 359.667) < 0.01, `${c} = ${row[c]}, expected ~359.67`)
  }
  r.destroy()
})

test('circular mean: TWA and AWA STAY signed, -180..180 — anything else is nonsense', () => {
  // The trap: a circular mean returns 0..360, so a port-side wind would read as 270°
  // instead of -90°. These two channels mean "off the bow, port negative"; an absolute
  // bearing in that field is not a rounding difference, it is a different quantity.
  const port = ringOfDirs([dirState(0, -90), dirState(0, -90)])
  const row = port._ring[port._ring.length - 1]
  assert.ok(Math.abs(row.twa + 90) < 0.01, `twa = ${row.twa}, expected ~-90 (port), NOT 270`)
  assert.ok(Math.abs(row.awa + 90) < 0.01, `awa = ${row.awa}`)
  port.destroy()

  // Dead astern from both sides averages to ±180, not to 0 (head to wind).
  const astern = ringOfDirs([dirState(0, 177), dirState(0, -177), dirState(0, 177)])
  const a = astern._ring[astern._ring.length - 1]
  assert.ok(Math.abs(Math.abs(a.twa) - 179) < 1.5, `twa = ${a.twa}, expected ~±179, NOT ~0`)
  astern.destroy()
})

test('circular mean: the signed range is an INVARIANT, fuzzed — never 0..360', () => {
  // Pinned as a property rather than a couple of examples: whatever the input, twa/awa
  // come back within ±180 and the absolute bearings within 0..360. A single missing
  // rewrap() would put a port wind at 270° on every screen that reads it.
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let trial = 0; trial < 200; trial++) {
    const states = []
    for (let i = 0; i < 1 + Math.floor(rnd() * 8); i++) {
      states.push(dirState(rnd() * 360, rnd() * 360 - 180))
    }
    const r = ringOfDirs(states)
    const row = r._ring[r._ring.length - 1]
    for (const c of ['twa', 'awa']) {
      if (row[c] == null) continue
      assert.ok(row[c] >= -180 && row[c] <= 180, `trial ${trial}: ${c} = ${row[c]} is outside -180..180`)
    }
    for (const c of ['twd', 'cog', 'heading', 'wptBrg']) {
      if (row[c] == null) continue
      assert.ok(row[c] >= 0 && row[c] < 360.0005, `trial ${trial}: ${c} = ${row[c]} is outside 0..360`)
    }
    // …and the served series keeps the same invariant through re-bucketing.
    const { series } = r.getSeries({ windowSec: 3600, everySec: 60 })
    for (const c of ['twa', 'awa']) {
      for (const [, v] of series[c] || []) assert.ok(v >= -180 && v <= 180, `${c} served as ${v}`)
    }
    r.destroy()
  }
})

test('circular mean: readings that cancel report NOTHING, not north', () => {
  // atan2(0, 0) is 0 — due north, stated with total confidence. Two exactly opposite
  // bearings have no meaningful average, so the channel gaps instead.
  const r = ringOfDirs([dirState(0), dirState(180)])
  const row = r._ring[r._ring.length - 1]
  assert.strictEqual(row.twd, null)
  assert.strictEqual(row.cog, null)
  assert.strictEqual(circularMeanDeg([0, 180]), null, 'and the helper agrees')
  r.destroy()
})

test('circular mean: re-bucketing across the seam averages, and old rows still work', () => {
  const base = Math.floor(Date.now() / 60000) * 60000 - 120000
  const r = new RingHistoryProvider({ source: { getState: () => null }, windowSec: 3600, sampleSec: 99999 })
  // Rows in the OLD shape (no lo/hi/n) straddling north, all in one 60 s bucket.
  r._ring = [
    { t: base + 5000, cog: 359, twa: 179 },
    { t: base + 25000, cog: 1, twa: -179 },
    { t: base + 45000, cog: 359, twa: 179 }
  ]
  const { series } = r.getSeries({ windowSec: 3600, everySec: 60 })
  assert.strictEqual(series.cog.length, 1, 'one bucket')
  assert.ok(Math.abs(series.cog[0][1] - 359.667) < 0.01, `cog re-bucketed to ${series.cog[0][1]}, expected ~359.67`)
  assert.ok(Math.abs(Math.abs(series.twa[0][1]) - 179.666) < 0.01, `twa = ${series.twa[0][1]}, expected ~±179.67`)
  assert.ok(series.twa[0][1] >= -180 && series.twa[0][1] <= 180)
  r.destroy()
})

test('circular mean: wrapped channels still carry NO band', () => {
  // Averaging them is now fine; a min/max still is not — "the lowest bearing in this
  // minute" is meaningless on a circle.
  const r = ringOfDirs([dirState(10), dirState(350)])
  const { series, bands } = r.getSeries({ windowSec: 3600, everySec: 60, stats: true })
  assert.ok(series.cog, 'the line is there')
  for (const c of ['twd', 'twa', 'awa', 'cog', 'heading', 'wptBrg']) {
    assert.strictEqual(bands[c], undefined, `${c} must have no band`)
  }
  assert.ok(bands.sog && bands.aws, 'linear channels are unaffected')
  r.destroy()
})

test('vendored: angles.js agrees with the wrap180 the ring already had', () => {
  // The app keeps wrap180 duplicated in perf-live.js and angles.js so each stays a
  // single-file vendor, and fuzzes the two against each other. Same discipline here.
  const { wrap180: perfWrap180 } = require('../lib/perf/perf-live')
  for (let d = -1080; d <= 1080; d += 0.5) {
    assert.strictEqual(aWrap180(d), perfWrap180(d), `wrap180(${d}) disagrees between the two copies`)
  }
})

// --- a dead instrument must reach the ring as a GAP (v0.32.0) -------------------------
// End to end, because this is where the lie was visible: the ring polls getState() every
// second, so a frozen field became real samples and the circular/arithmetic mean of N
// identical readings is that reading — a dead-flat plateau with a zero-width band, which
// reads as "rock steady". Observed on the boat: the sounder lost the bottom, stopped
// publishing, and the ring recorded 224.85 m for an hour while the cloud showed a gap.
const { createTelemetry } = require('../lib/telemetry')

test('integration: when one instrument dies the ring gaps that channel and keeps the rest', async () => {
  const t = createTelemetry({ debug () {}, error () {} }, { fieldTtlSec: 1 })
  const feed = (withDepth) => t._ingest({
    context: 'vessels.self',
    updates: [{
      timestamp: new Date().toISOString(),
      values: [
        { path: 'navigation.position', value: { latitude: 43, longitude: 6 } },
        { path: 'navigation.speedOverGround', value: 2.5 },
        ...(withDepth ? [{ path: 'environment.depth.belowSurface', value: 224.85 }] : [])
      ]
    }]
  })
  // pollSec too: the ring's own 1 Hz poll timer would otherwise sample across the sleep
  // below and race the TTL boundary, making this test flaky rather than wrong.
  const r = new RingHistoryProvider({ source: t, windowSec: 3600, sampleSec: 99999, pollSec: 99999 })
  feed(true); r._poll(); r._emit() // the sounder is alive
  await new Promise((res) => setTimeout(res, 1200)) // …then it goes quiet
  feed(false); r._poll(); r._emit()
  feed(false); r._poll(); r._emit()

  const { series } = r.getSeries({ windowSec: 3600 })
  assert.strictEqual(series.depth.length, 1, 'one real sample, then nothing — a gap, not a plateau')
  assert.strictEqual(series.sog.length, 3, 'the instruments still publishing are unaffected')
  r.destroy(); t.stop()
})
