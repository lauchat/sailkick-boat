'use strict'

// Live polar performance, computed on the boat.
//
// Section 1 replays the UPSTREAM suite (sailkick tests/test-perf-live.mjs @ 128cf97)
// against our vendored copy. That is the point of vendoring: if the boat's number ever
// diverges from what the app's screens show, these fail. Do not "improve" the maths here
// — fix it upstream and re-vendor.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createLivePerf, perfPct, wrap180, EMA_TAU_S, MIN_TWS } = require('../lib/perf/perf-live')
const { createPerf } = require('../lib/perf')

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps
// The upstream stub, verbatim.
const polarStub = { noGoTwa: 35, speed: (tws, twa) => (Math.abs(twa) < 35 ? 0 : Math.min(8, tws * 0.5)) }

// ---------- 1. the vendored maths, against the upstream assertions ----------
test('vendored: wrap180', () => {
  assert.strictEqual(wrap180(185), -175)
  assert.strictEqual(wrap180(-185), 175)
  assert.strictEqual(wrap180(360), 0)
})

test('vendored: EMA seeds on the first sample, then smooths by the documented alpha', () => {
  const p = createLivePerf()
  let t = 1000000
  const s1 = p.update({ twaDeg: 60, stwKt: 6, twsKt: 12 }, t)
  assert.ok(s1.ema.twa === 60 && s1.ema.kt === 6, 'first sample seeds exactly')
  t += 1000
  const s2 = p.update({ twaDeg: 80, stwKt: 8, twsKt: 12 }, t)
  assert.ok(s2.ema.twa > 60 && s2.ema.twa < 80, 'moves part way')
  const a = 1 / (EMA_TAU_S + 1)
  assert.ok(near(s2.ema.twa, 60 + 20 * a) && near(s2.ema.kt, 6 + 2 * a), 'by the documented alpha')
})

test('vendored: THE GYBE — smoothing crosses the stern, not the bow', () => {
  // The reason the outer wrap180 exists. Without it a 175°S -> 175°P gybe walks the EMA
  // past 180 and the label reads "190° S", and any port/starboard test flips wrong.
  const p = createLivePerf()
  let t = 0
  p.update({ twaDeg: 175, stwKt: 6, twsKt: 12 }, t)
  for (let i = 0; i < 50; i++) { t += 1000; p.update({ twaDeg: -175, stwKt: 6, twsKt: 12 }, t) }
  const e = p.ema
  assert.ok(Math.abs(wrap180(e.twa - -175)) < 2, `settles near -175, got ${e.twa}`)
  assert.ok(e.twa >= -180 && e.twa <= 180, `stays in range, got ${e.twa}`)
})

test('vendored: fallbacks and resets', () => {
  const p = createLivePerf()
  const s = p.update({ twdDeg: 200, headingDeg: 150, sogKt: 5, twsKt: 10 }, 0)
  assert.strictEqual(s.raw.twa, 50, 'TWA derived from TWD - HDG')
  assert.strictEqual(p.usingSog, true, 'SOG fallback flagged')
  const s2 = p.update({ twaDeg: 40, stwKt: 6, twsKt: 10 }, 1000)
  assert.strictEqual(s2.raw.twa, 40, 'published TWA preferred')
  assert.strictEqual(p.usingSog, false, 'STW clears the flag')
  const s3 = p.update({ twsKt: 10 }, 2000)
  assert.ok(s3 === null && p.ema === null, 'missing inputs reset the EMA — gaps are not smoothed across')
})

test('vendored: the 1-minute TWS window', () => {
  const p = createLivePerf()
  p.update({ twaDeg: 60, stwKt: 6, twsKt: 10 }, 0)
  p.update({ twaDeg: 60, stwKt: 6, twsKt: 20 }, 30000)
  assert.ok(near(p.avgTws(30000), 15))
  assert.ok(near(p.avgTws(85000), 20), 'old samples age out')
  assert.strictEqual(p.avgTws(120000), null, 'a fully aged window is null')
  assert.strictEqual(createLivePerf().avgTws(0), null)
})

test('vendored: perfPct guards', () => {
  const ema = { twa: 60, kt: 3 }
  assert.strictEqual(perfPct(null, 12, ema).kind, 'nodata')
  assert.strictEqual(perfPct(polarStub, 12, null).kind, 'nodata')
  assert.strictEqual(perfPct(polarStub, null, ema).kind, 'nodata')
  assert.strictEqual(perfPct(polarStub, 12, { twa: -20, kt: 3 }).kind, 'irons')
  const weak = perfPct(polarStub, MIN_TWS - 0.5, ema)
  assert.ok(weak.kind === 'weak' && Number.isFinite(weak.target))
  const ok = perfPct(polarStub, 12, ema)
  assert.ok(ok.kind === 'ok' && ok.pct === 50 && ok.target === 6)
  assert.strictEqual(perfPct(polarStub, 12, { twa: -60, kt: 3 }).pct, 50, 'negative TWA uses |twa|')
})

test('vendored: provenance headers name the upstream commit and hash', () => {
  for (const f of ['perf-live.js', 'polar.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'perf', f), 'utf8')
    assert.match(src, /VENDORED from sailkick\/shared\/engine\//, `${f} declares its origin`)
    assert.match(src, /@ [0-9a-f]{7,}\s+sha256:[0-9a-f]{16}/, `${f} pins commit + hash`)
    assert.match(src, /Do not edit here/, `${f} says where to fix it`)
  }
})

// ---------- 2. the boat module ----------
let seq = 0
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `sk-perf-${process.pid}-${seq++}-`))
const CSV = '# Test boat\n,6,10,14\n40,4,6,7\n90,5,8,9.5\n150,4.5,7,8\n'

function harness ({ profile, csvName = 'Test', state } = {}) {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'store', 'polars'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'store', 'polars', `${csvName}.csv`), CSV)
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile))
  const emitted = []
  const app = {
    debug () {}, error () {},
    handleMessage: (id, delta) => emitted.push(delta)
  }
  let cur = state
  const perf = createPerf(app, {
    source: { getState: () => cur },
    storeDir: path.join(dir, 'store'),
    profileFile: path.join(dir, 'profile.json'),
    intervalMs: 100000, // we drive _tick() by hand
    polarReloadMs: 100000
  })
  return { perf, emitted, dir, set: (s) => { cur = s }, profileFile: path.join(dir, 'profile.json') }
}

const sailing = (t) => ({ twaDeg: 90, stwKt: 8, twsKt: 10, updatedAt: new Date(t).toISOString() })

test('perf: resolves the catalogue polar from the mirror cache and emits SI deltas', () => {
  const h = harness({ profile: { activePolar: 'Test', polars: [] }, state: sailing(1e12) })
  h.perf.start()
  assert.ok(h.perf._polar(), 'polar loaded from store/polars/Test.csv')
  // Two samples so the EMA and the TWS window are populated.
  h.perf._tick()
  h.set(sailing(1e12 + 1000)); h.perf._tick()
  assert.strictEqual(h.perf.getPerf(), 100, 'the ring samples the integer percentage')
  h.perf.stop()
  assert.strictEqual(h.perf.getPerf(), null, 'and stop() clears it, so a stopped module gaps the channel')

  assert.ok(h.emitted.length >= 1, 'emitted deltas')
  const vals = h.emitted[h.emitted.length - 1].updates[0].values
  const byPath = Object.fromEntries(vals.map((v) => [v.path, v.value]))
  assert.ok('performance.polarSpeed' in byPath && 'performance.polarSpeedRatio' in byPath)
  // target at tws 10, twa 90 is 8 kt -> 8/1.94384 m/s; boat is doing 8 kt -> ratio 1
  assert.ok(Math.abs(byPath['performance.polarSpeed'] - 8 / 1.94384) < 0.01, 'target is METRES PER SECOND')
  assert.ok(Math.abs(byPath['performance.polarSpeedRatio'] - 1) < 0.02, 'ratio is 0-1, not a percentage')
})

test('perf: the guarded states emit NOTHING and gap the channel', () => {
  for (const [name, st] of [
    ['in irons', { twaDeg: 10, stwKt: 2, twsKt: 10 }],
    ['calm', { twaDeg: 90, stwKt: 0.2, twsKt: 0.5 }],
    ['no wind data', { twaDeg: 90, stwKt: 8 }]
  ]) {
    const h = harness({ profile: { activePolar: 'Test', polars: [] }, state: { ...st, updatedAt: new Date(1e12).toISOString() } })
    h.perf.start(); h.perf._tick(); h.perf._tick()
    assert.strictEqual(h.emitted.length, 0, `${name}: nothing emitted`)
    assert.strictEqual(h.perf.getPerf(), null, `${name}: the ring records a GAP, not a zero`)
    h.perf.stop()
  }
})

test('perf: an own: polar comes from the profile itself, not the tile cache', () => {
  const h = harness({
    profile: { activePolar: 'own:abc', polars: [{ id: 'abc', name: 'Mine', csv: CSV }] },
    state: sailing(1e12)
  })
  h.perf.start()
  assert.ok(h.perf._polar(), 'parsed from profile.polars[].csv')
  h.perf.stop()
})

test('perf: a missing or unparseable polar is reported, never guessed', () => {
  const a = harness({ profile: { activePolar: 'NotCached', polars: [] }, state: sailing(1e12) })
  a.perf.start()
  assert.strictEqual(a.perf._polar(), null)
  assert.match(a.perf.status(), /not on the boat yet/)
  a.perf._tick()
  assert.strictEqual(a.emitted.length, 0, 'and emits nothing')
  a.perf.stop()

  const b = harness({ profile: { activePolar: 'own:x', polars: [{ id: 'x', csv: 'nonsense' }] }, state: sailing(1e12) })
  b.perf.start()
  assert.strictEqual(b.perf._polar(), null)
  assert.match(b.perf.status(), /will not parse/)
  b.perf.stop()

  const c = harness({ profile: { polars: [] }, state: sailing(1e12) })
  c.perf.start()
  assert.match(c.perf.status(), /no active polar/)
  c.perf.stop()
})

test('perf: switching the active polar is picked up without a restart', () => {
  const h = harness({ profile: { activePolar: 'Test', polars: [] }, state: sailing(1e12) })
  h.perf.start()
  assert.strictEqual(h.perf._polar().id, 'Test')
  fs.writeFileSync(h.profileFile, JSON.stringify({ activePolar: 'own:new', polars: [{ id: 'new', csv: CSV }] }))
  h.perf._loadPolar()
  assert.strictEqual(h.perf._polar().id, 'own:new', 'reloaded in place')
  h.perf.stop()
})

test('perf: uses the SignalK timestamp, not wall clock, so replay is deterministic', () => {
  // Two runs over the same samples with the same SignalK times must agree exactly, even
  // though real time between them differs.
  const run = () => {
    const h = harness({ profile: { activePolar: 'Test', polars: [] }, state: sailing(1e12) })
    h.perf.start()
    for (let i = 0; i < 6; i++) {
      h.set({ twaDeg: 60 + i * 5, stwKt: 6 + i * 0.2, twsKt: 12, updatedAt: new Date(1e12 + i * 1000).toISOString() })
      h.perf._tick()
    }
    const out = h.perf.getPerf()
    h.perf.stop()
    return out
  }
  const a = run(); const b = run()
  assert.strictEqual(a, b, 'identical inputs -> identical output regardless of wall clock')
  assert.ok(Number.isFinite(a))
})

test('perf: a SOG-derived percentage is flagged rather than passed off as through-water', () => {
  const h = harness({
    profile: { activePolar: 'Test', polars: [] },
    state: { twaDeg: 90, sogKt: 8, twsKt: 10, updatedAt: new Date(1e12).toISOString() }
  })
  h.perf.start(); h.perf._tick(); h.perf._tick()
  assert.match(h.perf.status(), /current-polluted/, 'the status line says so')
  assert.ok(h.emitted.length > 0, 'but it is still recorded — matches what the screens show')
  h.perf.stop()
})

// ---------- 3. the ring channel ----------
const { RingHistoryProvider, CHANNELS } = require('../lib/history/ring')

test('ring: perf is a channel, and a guarded sample gaps rather than reading zero', () => {
  assert.ok(CHANNELS.includes('perf'))
  let pct = 92
  const r = new RingHistoryProvider({
    source: { getState: () => ({ sogKt: 6, cogDeg: 90, headingDeg: 90, lat: 1, lon: 2 }) },
    perfSource: { getPerf: () => pct },
    sampleSec: 1,
    windowSec: 60
  })
  let s = r.getSeries({ windowSec: 60 })
  assert.ok(s.series.perf && s.series.perf[0][1] === 92, 'recorded')
  pct = null // in irons
  r._sample()
  s = r.getSeries({ windowSec: 60 })
  assert.strictEqual(s.series.perf.length, 1, 'the guarded sample is absent, not 0')
  r.destroy && r.destroy()
})
