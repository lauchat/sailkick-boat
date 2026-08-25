'use strict'

// Two halves, as with test/perf.test.js:
//
//   1. THE VENDORED EVALUATOR — the app's own suite (tests/test-alerts.mjs, 30 assertions)
//      replayed against lib/alerts/alerts.js. Every one of them is a failure mode:
//      flapping, wrap-around, anchor swing, data gaps. If our CommonJS copy answers
//      differently from theirs, an alarm means two things depending on who noticed, which
//      is the drift this vendoring exists to prevent.
//
//   2. THE BOAT HOST — the parts that are ours: pulling state on a timer, the polar % the
//      evaluator expects but our BoatState does not carry, clock handling, and delivery
//      onto the SignalK bus.
//
// Upstream warning, kept because it applies to this copy too: the flapping case is
// survived by the hold time alone (alternating samples never accumulate continuous
// failure), so it does NOT prove the deadband. A mutation removing clearKt passed it. The
// case that pins the deadband is steady 23 kt against a 25/22 rule — [2b] below.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createAlertEngine, STALE_SEC } = require('../lib/alerts/alerts')
const { greatCircleKm } = require('../lib/alerts/great-circle')
const { createAlerts, ANCHOR_PATH, nsPath } = require('../lib/alerts')

const T0 = 1700000000000

// Feed a series of states at `stepSec` intervals, collecting every transition — the same
// harness shape the upstream suite uses, so the cases port across unchanged.
function run (engine, states, { stepSec = 10, t0 = T0 } = {}) {
  const events = []
  let t = t0
  for (const s of states) {
    events.push(...engine.update(s, t))
    t += stepSec * 1000
  }
  return { events, endT: t }
}
const rep = (n, v) => Array.from({ length: n }, () => v)

// ---------- 1. the vendored evaluator ----------

test('alerts: a threshold crossing raises once the hold time passes', () => {
  const e = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 30 }])
  const { events } = run(e, [...rep(2, { twsKt: 12 }), ...rep(6, { twsKt: 28 })])
  assert.strictEqual(events.filter((x) => x.transition === 'raised').length, 1, 'exactly one raise')
  assert.strictEqual(events[0].context.value, 28, 'carries the value that tripped it')
  assert.ok(e.isRaised('w') && e.active.includes('w'))
  assert.strictEqual(
    createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 30 }]).update({ twsKt: 28 }, T0).length, 0,
    'does not raise before the hold elapses')
})

test('alerts: FLAPPING — wind oscillating on the threshold fires once, not forty times', () => {
  const e = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, clearKt: 22, forSec: 30, clearSec: 30 }])
  const jitter = Array.from({ length: 40 }, (_, i) => ({ twsKt: 25 + (i % 2 ? 1.5 : -1.5) }))
  const { events } = run(e, [...rep(6, { twsKt: 28 }), ...jitter])
  assert.strictEqual(events.filter((x) => x.transition === 'raised').length, 1, 'one raise across the oscillation')
  assert.strictEqual(events.filter((x) => x.transition === 'cleared').length, 0, 'no clear during it')
  assert.ok(e.isRaised('w'), 'still raised at the end')
})

test('alerts: the DEADBAND isolated — steady 23 kt does not clear a 25/22 rule', () => {
  // The one the upstream mutation test caught: this must fail if clearKt stops being used.
  const d = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, clearKt: 22, forSec: 30, clearSec: 30 }])
  const dead = run(d, [...rep(6, { twsKt: 28 }), ...rep(12, { twsKt: 23 })])
  assert.strictEqual(dead.events.filter((x) => x.transition === 'cleared').length, 0)
  assert.ok(d.isRaised('w'))

  // Same rule, same duration, below the clear threshold — proves the above is not just
  // "never clears".
  const d2 = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, clearKt: 22, forSec: 30, clearSec: 30 }])
  const below = run(d2, [...rep(6, { twsKt: 28 }), ...rep(12, { twsKt: 21 })])
  assert.ok(below.events.some((x) => x.transition === 'cleared') && !d2.isRaised('w'), 'steady 21 kt DOES clear it')
})

test('alerts: it clears, but only below the deadband and only after clearSec', () => {
  const e = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, clearKt: 22, forSec: 30, clearSec: 30 }])
  const { events } = run(e, [...rep(6, { twsKt: 30 }), ...rep(6, { twsKt: 15 })])
  assert.strictEqual(events.map((x) => x.transition).join(','), 'raised,cleared')
  assert.ok(!e.isRaised('w') && e.active.length === 0)
})

test('alerts: WRAP-AROUND — 350° -> 010° is a 20° veer, not 340°', () => {
  const mk = () => createAlertEngine([{ id: 's', kind: 'wind-shift', deg: 40, windowSec: 600, forSec: 30 }])
  const small = run(mk(), [...rep(6, { twdDeg: 350 }), ...rep(6, { twdDeg: 10 })])
  assert.strictEqual(small.events.length, 0, '20° across north does not fire')
  const big = run(mk(), [...rep(6, { twdDeg: 340 }), ...rep(6, { twdDeg: 40 })])
  assert.ok(big.events.some((x) => x.transition === 'raised'), '60° across north does fire')
  assert.strictEqual(big.events[0].context.value, 60, 'reports the shortest-path magnitude')
})

test('alerts: ANCHOR — a swinging boat with GPS scatter never alarms; a drag does', () => {
  // 30 m swing circle + ~8 m of wander, inside a 50 m radius. 1e-5 deg ~ 1.1 m.
  const swing = Array.from({ length: 60 }, (_, i) => ({
    lat: 43.0 + Math.sin(i / 4) * 0.00027 + (i % 3 - 1) * 0.00007,
    lon: 6.0 + Math.cos(i / 4) * 0.00027 + (i % 2 ? 0.00007 : -0.00007)
  }))
  const rule = { id: 'a', kind: 'anchor-drift', anchor: { lat: 43.0, lon: 6.0 }, radiusM: 50, forSec: 60 }
  assert.strictEqual(run(createAlertEngine([rule]), swing).events.length, 0, 'swinging at anchor never alarms')

  const drag = Array.from({ length: 30 }, (_, i) => ({ lat: 43.0 + i * 0.00006, lon: 6.0 }))
  const { events } = run(createAlertEngine([rule]), [...swing, ...drag])
  const raised = events.find((x) => x.transition === 'raised')
  assert.ok(raised, 'dragging out of the circle alarms')
  assert.ok(raised.context.value >= 50, 'reports the distance in metres')
})

test('alerts: DATA GAPS — a dead feed must not clear a raised alarm', () => {
  const e = createAlertEngine([{ id: 'a', kind: 'anchor-drift', anchor: { lat: 43, lon: 6 }, radiusM: 50, forSec: 0 }])
  run(e, rep(4, { lat: 43.001, lon: 6 })) // ~111 m out
  assert.ok(e.isRaised('a'), 'alarm is up')
  const after = run(e, rep(20, { twsKt: 12 }), { t0: T0 + 60000 }) // position stops arriving
  assert.strictEqual(after.events.length, 0, 'no clear while position is missing')
  assert.ok(e.isRaised('a'), 'still raised')
})

test('alerts: staleness is its own condition, not a rule clearing', () => {
  const e = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 0 }])
  e.update({ twsKt: 30 }, T0)
  assert.strictEqual(e.tick(T0 + 1000).length, 0, 'nothing stale while fresh')
  const ev = e.tick(T0 + 200000)
  assert.strictEqual(ev[0].kind, 'feed-stale')
  assert.strictEqual(ev[0].transition, 'raised')
  assert.strictEqual(e.tick(T0 + 210000).length, 0, 'fires the transition once')
  assert.ok(e.isRaised('w'), 'the wind alarm is untouched by staleness')
  e.update({ twsKt: 30 }, T0 + 220000)
  assert.strictEqual(e.tick(T0 + 221000)[0].transition, 'cleared', 'recovers when data returns')
})

test('alerts: hygiene — disabled, unknown, null and missing inputs are all inert', () => {
  assert.strictEqual(
    run(createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 0, enabled: false }]), rep(5, { twsKt: 40 })).events.length,
    0, 'disabled rules never fire')
  assert.strictEqual(
    run(createAlertEngine([{ id: 'x', kind: 'no-such-kind', forSec: 0 }]), rep(3, { twsKt: 40 })).events.length,
    0, 'an unknown kind is inert, not a crash')
  const n = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 0 }])
  assert.ok(n.update(null, T0).length === 0 && n.update(undefined, T0).length === 0, 'garbage state ignored')
  // Absent is undefined on the boat and null in the cloud — neither may read as 0.
  const z = createAlertEngine([{ id: 'b', kind: 'wind-below', twsKt: 5, forSec: 0 }])
  assert.ok(z.update({ twsKt: null }, T0).length === 0 && z.update({}, T0 + 1000).length === 0,
    'missing wind does not trip a "below" rule')
  const a = createAlertEngine([{ id: 'a', kind: 'anchor-drift', radiusM: 50, forSec: 0 }])
  assert.strictEqual(a.update({ lat: 43.001, lon: 6 }, T0).length, 0, 'no datum yet ⇒ inert')
  a.setAnchor('a', 43, 6)
  assert.strictEqual(a.update({ lat: 43.001, lon: 6 }, T0 + 1000).length, 1, 'setAnchor sets the datum')
})

test('vendored: greatCircleKm matches the upstream haversine it was copied from', () => {
  // Copied alone out of shared/engine/wind-field.js:256 rather than vendoring a grid
  // module for eight lines — so it needs its own equivalence check.
  assert.strictEqual(greatCircleKm(43, 6, 44, 6).toFixed(3), '111.195', 'one degree of latitude')
  assert.strictEqual((greatCircleKm(43, 6, 43.00045, 6) * 1000).toFixed(2), '50.04', 'the anchor-radius scale')
  assert.strictEqual(greatCircleKm(43, 6, 43, 6), 0, 'zero distance')
})

test('vendored: provenance headers name the upstream commit and hash', () => {
  for (const f of ['alerts.js', 'great-circle.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'alerts', f), 'utf8')
    assert.match(src, /VENDORED from sailkick\/shared\/engine\//, `${f} declares its origin`)
    assert.match(src, /@ [0-9a-f]{7,}\s+sha256:[0-9a-f]{16}/, `${f} pins commit + hash`)
    assert.match(src, /Do not edit here/, `${f} says where to fix it`)
  }
})

// ---------- 2. the boat host ----------

let seq = 0
function host (rules, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sk-alerts-${process.pid}-${seq++}-`))
  const profileFile = path.join(dir, 'profile.json')
  fs.writeFileSync(profileFile, JSON.stringify({ alerts: rules }))
  const sent = []
  const logs = []
  const app = {
    debug: (m) => logs.push(m),
    error: (m) => logs.push(m),
    handleMessage: (_id, delta) => sent.push(...delta.updates[0].values)
  }
  let state = null
  const a = createAlerts(app, {
    source: { getState: () => state },
    profileFile,
    ...opts
  })
  a.start()
  // Feed one sample. `ageSec` puts the SignalK timestamp that far in the past, which is
  // how these tests move the engine's clock without sleeping: the host only accepts a
  // timestamp within its skew bound, so time has to be simulated inside that window.
  const feed = (s, ageSec = 0) => {
    state = s && { ...s, updatedAt: new Date(Date.now() - ageSec * 1000).toISOString() }
    a._tick()
  }
  const last = (p) => [...sent].reverse().find((v) => v.path === p)
  return { a, feed, sent, last, logs, profileFile, dir }
}

const WIND_HI = { id: 'w1', kind: 'wind-above', twsKt: 25, clearKt: 22, forSec: 0, clearSec: 0 }
const ANCHOR = { id: 'a1', kind: 'anchor-drift', anchor: { lat: 43, lon: 6 }, radiusM: 50, forSec: 0, clearSec: 0 }

test('host: an anchor drag lands on the conventional SignalK path as an alarm', () => {
  const h = host([ANCHOR])
  h.feed({ lat: 43.0, lon: 6.0 }, 20)
  assert.strictEqual(h.sent.length, 0, 'sitting on the datum raises nothing')

  h.feed({ lat: 43.001, lon: 6.0 }, 10) // ~111 m out
  const n = h.last(ANCHOR_PATH)
  assert.ok(n, `raised on ${ANCHOR_PATH}`)
  assert.strictEqual(n.value.state, 'alarm', 'dragging is an alarm, not an alert')
  assert.deepStrictEqual(n.value.method, ['visual', 'sound'], 'it has to make a noise')
  assert.match(n.value.message, /111 m from the datum \(limit 50 m\)/, 'says how far, and from what')

  h.feed({ lat: 43.0, lon: 6.0 }, 5) // back inside
  assert.strictEqual(h.last(ANCHOR_PATH).value.state, 'normal', 'cleared with state normal, not by deleting the path')
  h.a.stop()
})

test('host: non-anchor rules get their own path, so two rules cannot overwrite each other', () => {
  const h = host([WIND_HI, { id: 'w2', kind: 'wind-below', twsKt: 5, forSec: 0, clearSec: 0 }])
  h.feed({ twsKt: 30 }, 10)
  assert.ok(h.last(nsPath('w1')), 'the over-wind rule raised on its own path')
  assert.strictEqual(h.last(nsPath('w1')).value.state, 'alert')
  assert.strictEqual(h.last(ANCHOR_PATH), undefined, 'nothing on the anchor path')

  h.feed({ twsKt: 2 }, 5)
  assert.strictEqual(h.last(nsPath('w1')).value.state, 'normal', 'the first rule cleared')
  assert.strictEqual(h.last(nsPath('w2')).value.state, 'alert', 'the second raised — separately')
  h.a.stop()
})

test('host: a second anchor rule does not steal the conventional path from the first', () => {
  const h = host([ANCHOR, { ...ANCHOR, id: 'a2', radiusM: 30 }])
  h.feed({ lat: 43.001, lon: 6.0 }, 10)
  const owner = [...h.a._raised()].find(([p]) => p === ANCHOR_PATH)
  assert.ok(owner, 'one of them owns notifications.navigation.anchor')
  assert.ok(h.a._raised().has(nsPath(owner[1] === 'a1' ? 'a2' : 'a1')), 'the other has its own path')
  assert.strictEqual(h.a._raised().size, 2, 'both are raised, neither overwritten')
  h.a.stop()
})

test('host: the polar % is injected — perf-below cannot fire without it', () => {
  const rule = [{ id: 'p1', kind: 'perf-below', pct: 80, forSec: 0, clearSec: 0 }]
  // BoatState has no perfPct field; without a perfSource the rule is simply inert, which
  // is what a missing input should be — not a false alarm.
  const blind = host(rule)
  blind.feed({ sogKt: 5 }, 10)
  assert.strictEqual(blind.sent.length, 0, 'no perf source ⇒ nothing fires')
  blind.a.stop()

  const wired = host(rule, { perfSource: { getPerf: () => 62 } })
  wired.feed({ sogKt: 5 }, 10)
  const n = wired.last(nsPath('p1'))
  assert.ok(n, 'with lib/perf wired, the rule sees the computed percentage')
  assert.match(n.value.message, /62% of polar/)
  wired.a.stop()
})

test('host: only fresh data advances the engine', () => {
  const h = host([WIND_HI])
  h.feed({ twsKt: 30 }, 10)
  const after = h.sent.length
  h.a._tick(); h.a._tick(); h.a._tick() // same sample, same timestamp
  assert.strictEqual(h.sent.length, after, 're-reading an unchanged sample emits nothing')
  h.a.stop()
})

test('host: a wildly wrong SignalK clock falls back to the system clock, once, loudly', () => {
  const h = host([WIND_HI])
  h.feed({ twsKt: 30 }, 7200) // two hours out
  assert.ok(h.last(nsPath('w1')), 'still evaluates')
  const warned = h.logs.filter((m) => /from this machine's clock/.test(m))
  assert.strictEqual(warned.length, 1, 'says so exactly once')
  h.feed({ twsKt: 31 }, 7100)
  assert.strictEqual(h.logs.filter((m) => /from this machine's clock/.test(m)).length, 1, 'and not again')
  h.a.stop()
})

test('host: editing rules while an alarm is up clears it rather than stranding it', () => {
  // A rebuilt engine has no memory of the raise, so it would never emit the matching
  // clear — the notification would sit at alarm for ever with nothing able to take it
  // down, which is how an owner learns to mute the path.
  const h = host([ANCHOR])
  h.feed({ lat: 43.001, lon: 6.0 }, 20)
  assert.strictEqual(h.last(ANCHOR_PATH).value.state, 'alarm')

  fs.writeFileSync(h.profileFile, JSON.stringify({ alerts: [{ ...ANCHOR, radiusM: 80 }] }))
  h.a._loadRules()
  assert.strictEqual(h.last(ANCHOR_PATH).value.state, 'normal', 'taken down on rule change')
  assert.strictEqual(h.a._raised().size, 0)
  assert.ok(h.logs.some((m) => /rules changed while 1 alarm/.test(m)), 'and said so')

  h.feed({ lat: 43.002, lon: 6.0 }, 10) // 222 m — past the new 80 m radius
  assert.strictEqual(h.last(ANCHOR_PATH).value.state, 'alarm', 're-arms under the new rule')
  h.a.stop()
})

test('host: re-reading identical rules is a no-op', () => {
  const h = host([ANCHOR])
  h.feed({ lat: 43.001, lon: 6.0 }, 20)
  const n = h.sent.length
  h.a._loadRules(); h.a._loadRules()
  assert.strictEqual(h.sent.length, n, 'an unchanged file does not disturb a raised alarm')
  assert.strictEqual(h.a._raised().size, 1)
  h.a.stop()
})

test('host: stopping clears what it raised, because nothing will evaluate it', () => {
  const h = host([ANCHOR])
  h.feed({ lat: 43.001, lon: 6.0 }, 10)
  assert.strictEqual(h.last(ANCHOR_PATH).value.state, 'alarm')
  h.a.stop()
  assert.strictEqual(h.last(ANCHOR_PATH).value.state, 'normal')
  assert.match(h.last(ANCHOR_PATH).value.message, /no longer being evaluated/)
})

test('host: notifications can be switched off without switching evaluation off', () => {
  const h = host([ANCHOR], { notifications: false })
  h.feed({ lat: 43.001, lon: 6.0 }, 10)
  assert.strictEqual(h.sent.length, 0, 'nothing on the bus')
  assert.ok(h.a.active().includes('a1'), 'but the rule is still evaluated and raised')
  assert.match(h.a.status(), /1 RAISED/)
  h.a.stop()
})

test('host: a rule may set its own severity, but only within the SignalK enums', () => {
  const h = host([{ ...WIND_HI, state: 'emergency', method: ['sound', 'telepathy'] }])
  h.feed({ twsKt: 30 }, 10)
  const n = h.last(nsPath('w1'))
  assert.strictEqual(n.value.state, 'emergency', 'an owner can escalate a rule')
  assert.deepStrictEqual(n.value.method, ['sound'], 'an invented method is dropped, not passed through')

  const bad = host([{ ...WIND_HI, id: 'w9', state: 'REALLY BAD' }])
  bad.feed({ twsKt: 30 }, 10)
  assert.strictEqual(bad.last(nsPath('w9')).value.state, 'alert', 'an invalid state falls back to the default')
  h.a.stop(); bad.a.stop()
})

test('host: a stale feed is reported on the status line, not as an alarm on the bus', () => {
  const h = host([WIND_HI])
  h.feed({ twsKt: 30 }, 10)
  const before = h.sent.length
  // Nothing arrives for longer than the engine's staleness timeout.
  const orig = Date.now
  try {
    Date.now = () => orig() + (STALE_SEC + 10) * 1000
    h.a._tick()
  } finally { Date.now = orig }
  assert.match(h.a.status(), /FEED STALE/)
  assert.strictEqual(h.sent.length, before, 'a dead feed does not ring the anchor bell')
  h.a.stop()
})

test('host: no rules is a quiet, valid state', () => {
  const h = host([])
  h.feed({ twsKt: 40, lat: 43.5, lon: 6 }, 10)
  assert.strictEqual(h.sent.length, 0)
  assert.match(h.a.status(), /no rules/)
  h.a.stop()
})

test('host: two sources fighting over the position are called out, because that alarm cannot fire', () => {
  // Detection now lives in the vendored evaluator (three jumps over MAX_PLAUSIBLE_KT
  // within five minutes); what is tested here is that the host surfaces its verdict.
  // Reproduces what this boat actually had: alternating fixes ~2.3 km apart.
  const h = host([ANCHOR])
  for (let i = 0; i < 12; i++) h.feed({ lat: i % 2 ? 43.0 : 43.0207, lon: 6.0 }, 40 - i)
  assert.ok(h.a._jumpy(), 'the conflict is recognised')
  assert.match(h.a.status(), /position is JUMPING between sources/)
  assert.ok(h.logs.some((m) => /more than one source is publishing navigation\.position/.test(m)),
    'and names the fix: pin the source')
  assert.strictEqual(h.logs.filter((m) => /more than one source/.test(m)).length, 1, 'said once, not per fix')
  assert.ok(!h.a.active().includes('a1'), 'and the anchor rule indeed never fired — the silent failure')
  h.a.stop()
})

test('host: real GPS scatter at rest is never mistaken for a source conflict', () => {
  // The actual receiver on this boat, at rest for 90 min: median 1.88 m from the centroid,
  // max 2.91 m, fix-to-fix max 1.28 m. Nothing at that scale may trip it, or the warning
  // becomes noise and gets ignored.
  const h = host([ANCHOR])
  for (let i = 0; i < 20; i++) {
    h.feed({ lat: 43.0 + (i % 3 - 1) * 0.000018, lon: 6.0 + (i % 2 ? 0.000018 : -0.000018) }, 30 - i)
  }
  assert.ok(!h.a._jumpy(), 'metres of scatter are not a source conflict')
  assert.match(h.a.status(), /none raised/)
  h.a.stop()
})

test('host: an invalid rule is dropped and named, not left looking armed', () => {
  // Validated with the app's own validateRule, vendored. A deadband on the wrong side of
  // the threshold is the subtle one: the alarm could never clear, and the evaluator would
  // treat the rule as inert while it sat in the list looking active.
  const h = host([
    { id: 'bad1', kind: 'wind-above', twsKt: 25, clearKt: 30, name: 'Gale' },
    { id: 'bad2', kind: 'no-such-kind' },
    WIND_HI
  ])
  assert.strictEqual(h.a._invalid(), 2, 'both bad rules dropped')
  assert.match(h.a.status(), /2 INVALID rule\(s\) ignored/)
  assert.ok(h.logs.some((m) => /"Gale" is NOT being evaluated.*can never clear/s.test(m)), 'says which, and why')
  h.feed({ twsKt: 30 }, 10)
  assert.ok(h.last(nsPath('w1')), 'the valid rule still works')
  h.a.stop()
})

test('alerts: POSITION SOURCE CONFLICT — the hazard that makes an anchor watch never fire', () => {
  // Upstream [8], replayed. This case came from this repo's own measurements.
  const rule = { id: 'a', kind: 'anchor-drift', anchor: { lat: 43, lon: 6 }, radiusM: 30, forSec: 60 }
  const e = createAlertEngine([rule])
  let t = T0
  for (let i = 0; i < 40; i++) { e.update({ lat: i % 2 ? 43.0 : 43.0207, lon: 6 }, t); t += 1000 }
  assert.ok(!e.isRaised('a'), 'the anchor rule indeed never fires (the silent failure)')
  const jumpy = e.tick(t).find((x) => x.kind === 'position-jumpy')
  assert.strictEqual(jumpy && jumpy.transition, 'raised', 'but the feed reports the conflict')
  assert.ok(jumpy.context.jumps >= 3, 'with how many impossible jumps it saw')
  assert.ok(e.active.includes('__feed__'), 'active() surfaces it')

  const g = createAlertEngine([rule])
  let gt = T0
  for (let i = 0; i < 20; i++) { g.update({ lat: i === 5 ? 44 : 43.0001, lon: 6 }, gt); gt += 1000 }
  assert.ok(!g.tick(gt).some((x) => x.kind === 'position-jumpy'), 'one lone glitch does not cry conflict')

  const sail = createAlertEngine([rule])
  let st = T0
  for (let i = 0; i < 60; i++) { sail.update({ lat: 43 + i * 0.00028, lon: 6 }, st); st += 60000 }
  assert.ok(!sail.tick(st).some((x) => x.kind === 'position-jumpy'), 'normal sailing never trips it')
})

test('alerts: the TWO CLOCKS contract — the trap that hides a dead feed', () => {
  // Upstream [9], and the bug this host actually had: pass the SAMPLE stamp to tick() and
  // a frozen feed looks fresh for ever, because the stamp stops advancing with the data.
  const e = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 0 }])
  e.update({ twsKt: 30 }, T0)
  assert.strictEqual(e.tick(T0).length, 0, 'sample clock into tick() ⇒ staleness can never fire')
  assert.ok(e.tick(T0 + 200000).some((x) => x.kind === 'feed-stale'), 'wall clock into tick() ⇒ it does')
})

test('alerts: validateRule rejects what would sit in the list doing nothing', () => {
  const { validateRule, RULE_KINDS } = require('../lib/alerts/alerts')
  assert.ok(validateRule({ kind: 'wind-above', twsKt: 25 }).ok)
  assert.match(validateRule({ kind: 'wind-above', twsKt: 25, clearKt: 30 }).error, /can never clear/)
  assert.match(validateRule({ kind: 'nope' }).error, /unknown kind/)
  assert.match(validateRule({ kind: 'anchor-drift', radiusM: 1 }).error, /between 5 and 5000/)
  assert.match(validateRule({ kind: 'anchor-drift', radiusM: 50, anchor: { lat: 200, lon: 0 } }).error, /anchor must be/)
  assert.ok(RULE_KINDS.includes('anchor-drift') && RULE_KINDS.length === 5)
})
