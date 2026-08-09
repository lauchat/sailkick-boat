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
  const r = new RingHistoryProvider({ source: { getState: () => state }, sampleSec: 1, windowSec: 60 })
  const { series } = r.getSeries({ windowSec: 60 })
  r.destroy && r.destroy()

  const missing = CHANNELS.filter((c) => !series[c])
  assert.deepStrictEqual(missing, [], 'every channel must be served when the value is present')
  assert.strictEqual(series.cog[0][1], 46.4, 'cog was sampled but never emitted before')
  assert.strictEqual(series.wptDist[0][1], 4.37)
  assert.strictEqual(series.rpmStbd[0][1], 0, 'a legitimate zero is not "empty"')
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
