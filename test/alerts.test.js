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
  // Upstream [9], strengthened after review. Simulates a dead feed as a host actually
  // experiences it: getState() keeps returning the same state, so its stamp never
  // advances, while real time runs on. The two loops are identical except for which clock
  // goes into tick() — so this discriminates a broken host rather than merely describing
  // the contract. This host HAD the bug; its own stale test caught it.
  const mk = () => createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 0 }])
  const FROZEN = T0
  const STEP = 30000; const TICKS = 30 // 15 minutes of real time, far past STALE_SEC

  const buggy = []
  const b = mk()
  for (let i = 0; i < TICKS; i++) {
    b.update({ twsKt: 30 }, FROZEN) // same sample, same stamp — nothing is arriving
    buggy.push(...b.tick(FROZEN)) // THE BUG: sample stamp into tick()
  }
  assert.strictEqual(buggy.length, 0, 'a host ticking with the SAMPLE stamp never notices the feed died')

  const right = []
  const g = mk()
  let wall = T0
  for (let i = 0; i < TICKS; i++) {
    g.update({ twsKt: 30 }, FROZEN) // identical dead feed…
    wall += STEP
    right.push(...g.tick(wall)) // …ticked with the WALL CLOCK
  }
  assert.ok(right.some((x) => x.kind === 'feed-stale' && x.transition === 'raised'),
    'the same feed, ticked with the wall clock, is reported dead')
  assert.strictEqual(right.filter((x) => x.kind === 'feed-stale').length, 1, 'reported once, not every tick')
  g.update({ twsKt: 30 }, wall) // a fresh sample, stamped now
  assert.ok(g.tick(wall + 1000).some((x) => x.kind === 'feed-stale' && x.transition === 'cleared'),
    'it clears when data genuinely resumes')
})

test('alerts: staleSec is configurable — the cloud heartbeat watches minutes, not seconds', () => {
  // New second argument at d54bfc1. The boat leaves it at the default; this pins that our
  // vendored copy carries the option, since a host that silently ignored it would watch
  // the wrong window.
  const e = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 0 }], { staleSec: 5 })
  e.update({ twsKt: 30 }, T0)
  assert.strictEqual(e.tick(T0 + 4000).length, 0, 'not yet')
  assert.ok(e.tick(T0 + 6000).some((x) => x.kind === 'feed-stale'), 'stale after the configured 5s')
  const dflt = createAlertEngine([{ id: 'w', kind: 'wind-above', twsKt: 25, forSec: 0 }])
  dflt.update({ twsKt: 30 }, T0)
  assert.strictEqual(dflt.tick(T0 + 6000).length, 0, 'and the default is still STALE_SEC')
  assert.strictEqual(STALE_SEC, 120)
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

// ---------- 3. the relay: alarms reaching a phone ashore ----------
// The transitions ride lib/sync's store-and-forward spool as Influx line protocol, so
// they inherit its guarantees (ordered, gapless across an offline passage, nothing lost
// on a restart) instead of needing a second, weaker delivery path. relay.js documents the
// schema; these pin it, because the cloud reader is written against it in another repo.

const { eventToLine, MEASUREMENT } = require('../lib/alerts/relay')

const parse = (line) => {
  // measurement,tagset fieldset ns — fields may contain escaped quotes and spaces, so
  // split on the LAST space and the first unquoted one.
  const ns = line.slice(line.lastIndexOf(' ') + 1)
  const head = line.slice(0, line.lastIndexOf(' '))
  const cut = head.indexOf(' ')
  const [meas, ...tagParts] = head.slice(0, cut).split(',')
  const tags = Object.fromEntries(tagParts.map((t) => t.split('=')))
  const fields = {}
  for (const m of head.slice(cut + 1).matchAll(/([a-zA-Z_]+)=("(?:[^"\\]|\\.)*"|[^,]+)/g)) {
    fields[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2]
  }
  return { meas, tags, fields, ns }
}

test('relay: a raise becomes one line whose series key is the rule, not its state', () => {
  const ev = {
    ruleId: 'a1',
    kind: 'anchor-drift',
    transition: 'raised',
    at: 1700000000123,
    context: { value: 111, rule: { id: 'a1', name: 'Anchor', radiusM: 50 } }
  }
  const p = parse(eventToLine(ev, { context: 'vessels.urn:mrn:imo:mmsi:269118770', state: 'alarm', message: 'Anchor — anchor drag: 111 m from the datum (limit 50 m)' }))
  assert.strictEqual(p.meas, MEASUREMENT)
  assert.deepStrictEqual(p.tags, {
    context: 'vessels.urn:mrn:imo:mmsi:269118770', self: 'true', rule: 'a1', kind: 'anchor-drift'
  }, 'tags are bounded and stable — transition and state are NOT among them')
  assert.strictEqual(p.fields.raised, '1i', 'machine-readable state: last(raised)==1 is "raised now"')
  assert.strictEqual(p.fields.transition, 'raised')
  assert.strictEqual(p.fields.state, 'alarm', 'the severity actually emitted, so delivery can decide to wake someone')
  assert.strictEqual(p.fields.value, '111', 'the tripping value stays numeric and chartable')
  assert.match(p.fields.message, /111 m from the datum/)
  assert.strictEqual(p.fields.name, 'Anchor')
  assert.strictEqual(p.ns, '1700000000123000000', 'nanoseconds, so a replayed batch overwrites rather than duplicates')
})

test('relay: raise and clear land on the SAME series, so one query answers "is it up?"', () => {
  const base = { ruleId: 'a1', kind: 'anchor-drift', at: 1700000000000, context: { value: 10, rule: {} } }
  const up = parse(eventToLine({ ...base, transition: 'raised' }, {}))
  const down = parse(eventToLine({ ...base, at: base.at + 60000, transition: 'cleared' }, {}))
  assert.deepStrictEqual(up.tags, down.tags,
    'identical tag set: as tags, transition would split each rule across two series and ' +
    '"is it raised" would become a merge-and-compare, wrong in the direction of "no alarm"')
  assert.strictEqual(down.fields.raised, '0i')
})

test('relay: commas, spaces and quotes in a rule name or message cannot break the line', () => {
  const line = eventToLine({
    ruleId: 'r,1 x',
    kind: 'wind-above',
    transition: 'raised',
    at: 1700000000000,
    context: { value: 31.5, rule: { name: 'Gale, "big" one\\here' } }
  }, { state: 'alert', message: 'wind 31.5 kt (over 25 kt), gusting' })
  // Asserted on the raw line: a tag value containing an escaped comma is precisely what a
  // naive split-on-comma parser gets wrong, so parsing it here would test the test.
  assert.match(line, /,rule=r\\,1\\ x,kind=wind-above /, 'tag escaping')
  const p = parse(line.replace('r\\,1\\ x', 'rid'))
  assert.match(line, /name="Gale, \\"big\\" one\\\\here"/, 'quotes and backslashes escaped in fields')
  assert.strictEqual(p.fields.value, '31.5')
})

test('relay: feed conditions ride the same measurement under the engine\'s own __feed__ id', () => {
  const p = parse(eventToLine({
    ruleId: '__feed__', kind: 'position-jumpy', transition: 'raised', at: 1700000000000,
    context: { jumps: 4, overKt: 100 }
  }, { state: 'warn', message: 'position source conflict' }))
  assert.strictEqual(p.tags.rule, '__feed__')
  assert.strictEqual(p.tags.kind, 'position-jumpy')
  assert.strictEqual(p.fields.jumps, '4i')
  assert.strictEqual(p.fields.state, 'warn')
})

test('relay: a malformed event produces nothing rather than a line Influx will reject', () => {
  // A rejected batch is quarantined by the spool, and quarantining an alarm is worse than
  // not recording it.
  assert.strictEqual(eventToLine(null, {}), null)
  assert.strictEqual(eventToLine({ kind: 'wind-above', transition: 'raised' }, {}), null, 'no ruleId')
  assert.strictEqual(eventToLine({ ruleId: 'x', kind: 'wind-above' }, {}), null, 'no transition')
  assert.strictEqual(eventToLine({ ruleId: 'x', transition: 'raised', at: 'not a date' }, {}), null, 'unparseable time')
})

test('host: alarms are handed to the spool as they happen, raise and clear', () => {
  const sent = []
  const h = host([ANCHOR], { relay: (lines) => { sent.push(...lines); return true } })
  h.feed({ lat: 43.0, lon: 6.0 }, 30)
  h.feed({ lat: 43.001, lon: 6.0 }, 20)
  h.feed({ lat: 43.0, lon: 6.0 }, 10)
  assert.strictEqual(sent.length, 2, 'one line per transition, not per tick')
  assert.match(sent[0], /^alerts,.*rule=a1,kind=anchor-drift raised=1i/)
  assert.match(sent[1], /raised=0i/)
  assert.ok(h.a.status().includes('2 sent to the cloud'))
  h.a.stop()
})

test('host: with no cloud sync, alarms still ring on board and the status line says so', () => {
  // The failure that must not happen quietly: believing an alarm reached a phone ashore.
  const h = host([ANCHOR]) // no relay wired
  h.feed({ lat: 43.001, lon: 6.0 }, 10)
  assert.ok(h.last(ANCHOR_PATH), 'the alarm still rings on the boat')
  assert.match(h.a.status(), /local only \(no cloud sync\)/)
  assert.ok(h.logs.some((m) => /not sent to the cloud/.test(m)))
  h.a.stop()
})

test('host: a relay that throws does not stop the alarm ringing', () => {
  const h = host([ANCHOR], { relay: () => { throw new Error('spool is full') } })
  h.feed({ lat: 43.001, lon: 6.0 }, 10)
  assert.strictEqual(h.last(ANCHOR_PATH).value.state, 'alarm', 'the bus still got it')
  assert.ok(h.logs.some((m) => /could not relay the alarm/.test(m)))
  h.a.stop()
})

// ---------- 4. drop anchor ----------
// The datum has to survive a restart and a rule edit — both of which happen at anchor —
// so it is written into the RULE, not only into the engine's memory. And it is taken from
// the boat's own fix, because that is the position the rule will be evaluated against; a
// browser would send whatever its last telemetry frame said, from a socket that may have
// dropped, which is exactly the moment this matters.
const { createProfile } = require('../lib/profile')

function anchorHarness (rule) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sk-drop-${process.pid}-${seq++}-`))
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ alerts: [rule] }, null, 2))
  const app = { debug () {}, error () {}, handleMessage () {} }
  const profile = createProfile(app, { dataDir: dir })
  let state = { lat: 43.5, lon: 6.5, updatedAt: new Date().toISOString() }
  const a = createAlerts(app, {
    source: { getState: () => state },
    profile,
    profileFile: path.join(dir, 'profile.json')
  })
  a.start()
  return { a, profile, dir, setState: (s) => { state = s } }
}

test('drop anchor: writes the datum into the rule and arms the watch immediately', async () => {
  const h = anchorHarness({ id: 'a1', kind: 'anchor-drift', radiusM: 50, forSec: 0, clearSec: 0, name: 'Anchor' })
  const r = await h.a.dropAnchor({ ruleId: 'a1' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.anchor.lat, 43.5, "the boat's own fix, not one the caller supplied")

  const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'profile.json'), 'utf8'))
  assert.deepStrictEqual(onDisk.alerts[0].anchor, { lat: 43.5, lon: 6.5 }, 'durable: survives a restart')
  // Armed now, not at the next rules reload: 111 m away must already be a drag.
  h.setState({ lat: 43.501, lon: 6.5, updatedAt: new Date().toISOString() })
  h.a._tick()
  assert.ok(h.a.active().includes('a1'), 'the watch was live from the moment it was set')
  h.a.stop()
})

test('drop anchor: refuses clearly rather than pretending the watch is set', async () => {
  const h = anchorHarness({ id: 'a1', kind: 'anchor-drift', radiusM: 50, forSec: 0 })
  assert.strictEqual((await h.a.dropAnchor({ ruleId: 'nope' })).status, 404)
  assert.strictEqual((await h.a.dropAnchor({})).status, 404)
  h.a.stop()

  const w = anchorHarness({ id: 'w1', kind: 'wind-above', twsKt: 25, forSec: 0 })
  const wrong = await w.a.dropAnchor({ ruleId: 'w1' })
  assert.strictEqual(wrong.status, 400)
  assert.match(wrong.message, /not an anchor watch/)
  w.a.stop()

  const n = anchorHarness({ id: 'a1', kind: 'anchor-drift', radiusM: 50, forSec: 0 })
  n.setState({ updatedAt: new Date().toISOString() }) // no fix
  const none = await n.a.dropAnchor({ ruleId: 'a1' })
  assert.strictEqual(none.status, 409)
  assert.match(none.message, /no position fix/)
  n.a.stop()
})

test('drop anchor: an explicit position is honoured (re-setting the datum by hand)', async () => {
  const h = anchorHarness({ id: 'a1', kind: 'anchor-drift', radiusM: 50, forSec: 0 })
  const r = await h.a.dropAnchor({ ruleId: 'a1', lat: 40.1, lon: -3.2 })
  assert.deepStrictEqual(r.anchor, { lat: 40.1, lon: -3.2 })
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'profile.json'), 'utf8')).alerts[0].anchor,
    { lat: 40.1, lon: -3.2 })
  h.a.stop()
})

// --- a frozen field must not be evaluated as live (v0.32.0) --------------------------
test('integration: a wind alarm cannot fire on a dead wind instrument', async () => {
  // Before per-field freshness this was the dangerous case: a rule armed at 25 kt kept
  // seeing the last live reading forever, so it could neither fire nor clear on reality.
  // With the field absent the shared evaluator's own semantics take over — "cannot tell"
  // — which never clears a raised alarm and never raises a new one on dead data.
  const { createTelemetry } = require('../lib/telemetry')
  const t = createTelemetry({ debug () {}, error () {} }, { fieldTtlSec: 1 })
  const feed = (tws) => t._ingest({
    context: 'vessels.self',
    updates: [{
      timestamp: new Date().toISOString(),
      values: [
        { path: 'navigation.position', value: { latitude: 43, longitude: 6 } },
        ...(tws == null ? [] : [{ path: 'environment.wind.speedTrue', value: tws }])
      ]
    }]
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sk-frozen-${process.pid}-`))
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    alerts: [{ id: 'w1', kind: 'wind-above', twsKt: 25, forSec: 0, clearSec: 0 }]
  }))
  const sent = []
  const a = createAlerts({ debug () {}, error () {}, handleMessage: (_i, d) => sent.push(...d.updates[0].values) },
    { source: t, profileFile: path.join(dir, 'profile.json') })
  a.start()

  feed(10) // 19.4 kt — under the threshold
  a._tick()
  assert.strictEqual(a.active().length, 0)

  await new Promise((res) => setTimeout(res, 1200)) // the wind instrument dies
  feed(null)
  a._tick()
  assert.strictEqual(a.active().length, 0, 'nothing fires on a field that is no longer there')
  assert.strictEqual(sent.length, 0, 'and nothing reached the bus')

  // A distinct millisecond: the host only re-evaluates when the sample's OWN timestamp
  // advances (that is what makes a frozen feed detectable), and two feeds inside one
  // millisecond look like the same sample — which made this test flaky, not wrong.
  await new Promise((res) => setTimeout(res, 5))
  feed(15) // 29 kt — a real gust, once the instrument is back
  a._tick()
  assert.ok(a.active().includes('w1'), 'a live reading still arms the alarm normally')
  a.stop(); t.stop()
})
