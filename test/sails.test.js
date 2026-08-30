'use strict'

// Two halves, as with perf and alerts:
//
//   1. THE VENDORED ENCODING — the app's own suite (tests/test-sails-encoding.mjs)
//      replayed against lib/sails/sails.js. Almost every assertion is a failure mode,
//      because this string is a JOIN KEY: the same sail plan must produce the same bytes
//      or one polar cloud silently splits into several that look unrelated — visible only
//      much later, as a mysteriously noisy polar.
//
//   2. THE WRITE DOOR — ours. The boat is the only host that accepts a sail plan, so this
//      is where a malformed one has to be stopped, and where the SignalK delta that
//      carries it to the cloud is published.

const test = require('node:test')
const assert = require('node:assert')

const {
  encodePlan, decodePlan, isCanonicalPlan, sailPlanKey, describePlan, validateSail,
  DEFAULT_INVENTORY, BARE
} = require('../lib/sails/sails')
const { createSails } = require('../lib/sails')

const ids = (plan) => decodePlan(plan).map((s) => s.id).join(',')

// ---------- 1. the vendored encoding ----------

test('sails: canonical order — the reason the module exists', () => {
  const a = encodePlan([{ id: 'main', reefs: 2 }, { id: 'genoa', reefs: 1 }])
  const b = encodePlan([{ id: 'genoa', reefs: 1 }, { id: 'main', reefs: 2 }])
  assert.strictEqual(a, b, 'same sails in opposite order encode identically')
  assert.strictEqual(a, 'genoa:1+main:2', 'sorted by id, not insertion order')

  // Three sails: two-element sorting can pass by luck, three cannot.
  const perms = [
    ['staysail', 'main', 'genoa'], ['genoa', 'staysail', 'main'], ['main', 'genoa', 'staysail'],
    ['staysail', 'genoa', 'main'], ['main', 'staysail', 'genoa'], ['genoa', 'main', 'staysail']
  ].map((p) => encodePlan(p.map((id) => ({ id, reefs: 0 }))))
  assert.strictEqual(new Set(perms).size, 1, 'all 6 permutations of 3 sails agree')

  assert.ok(isCanonicalPlan('genoa:1+main:2'))
  assert.ok(!isCanonicalPlan('main:2+genoa:1'), 'a mis-sorted string is NOT canonical')
  assert.strictEqual(sailPlanKey('genoa:0+main:0'), 'genoa:0+main:0')
  assert.ok(sailPlanKey(null) === null && sailPlanKey('') === null)
})

test('sails: the combinations a per-station model cannot express', () => {
  // The case that killed the station model: a cutter in heavy weather carries a partly
  // furled genoa AND the storm jib on the inner forestay. Both are up at once.
  const heavy = encodePlan([{ id: 'genoa', reefs: 2 }, { id: 'stormjib', reefs: 0 }, { id: 'main', reefs: 3 }])
  assert.strictEqual(heavy, 'genoa:2+main:3+stormjib:0')
  const back = decodePlan(heavy)
  assert.strictEqual(back.length, 3)
  assert.strictEqual(back.find((s) => s.id === 'genoa').reefs, 2)

  assert.strictEqual(encodePlan([{ id: 'staysail', reefs: 0 }, { id: 'genoa', reefs: 0 }]), 'genoa:0+staysail:0')
  assert.strictEqual(encodePlan([{ id: 'main', reefs: 1 }]), 'main:1', 'main alone, headsail struck')
  assert.strictEqual(encodePlan([{ id: 'spinnaker', reefs: 0 }, { id: 'main', reefs: 0 }]), 'main:0+spinnaker:0')
  assert.strictEqual(encodePlan([{ id: 'main', reefs: 0 }, { id: 'main', reefs: 2 }]), 'main:2', 'a duplicate collapses')
})

test('sails: bare poles is data; absent is not', () => {
  assert.strictEqual(encodePlan([]), BARE)
  assert.strictEqual(decodePlan(BARE).length, 0)
  assert.ok(isCanonicalPlan(BARE))
  assert.strictEqual(describePlan(BARE), 'Bare poles')
  assert.ok(describePlan(null) === '—' && describePlan('') === '—', 'no data is not bare poles')
  assert.ok(sailPlanKey(BARE) === BARE && sailPlanKey(null) === null, 'they never group together')
})

test('sails: history outlives the inventory — decoding stays tolerant', () => {
  const old = 'ghoster:0+main:1' // a sail since deleted from the boat's inventory
  assert.strictEqual(ids(old), 'ghoster,main')
  assert.ok(describePlan(old).includes('ghoster'), 'falls back to the raw id rather than blank')

  assert.strictEqual(decodePlan('!!!').length, 0, 'garbage decodes to empty, not a throw')
  assert.ok(decodePlan(undefined).length === 0 && decodePlan(42).length === 0)
  assert.strictEqual(ids('main+genoa:0'), 'genoa', 'a segment with no reef count is dropped')
  assert.strictEqual(ids('main:1.5+genoa:0'), 'genoa')
  assert.strictEqual(ids('main:99+genoa:0'), 'genoa')
  assert.ok(encodePlan(null) === BARE && encodePlan('main') === BARE)
  assert.strictEqual(encodePlan([{ id: 'main', reefs: 'x' }]), 'main:0', 'NaN clamps rather than corrupting')
  assert.strictEqual(encodePlan([{ id: 'main', reefs: -3 }]), 'main:0')
  // An id carrying the delimiters would produce a string that decodes to something else.
  assert.strictEqual(encodePlan([{ id: 'a+b', reefs: 0 }, { id: 'c:d', reefs: 0 }]), BARE)
})

test('sails: describePlan speaks like a sailor', () => {
  assert.strictEqual(describePlan('genoa:0+main:0'), 'Genoa · Mainsail')
  assert.strictEqual(describePlan('main:2'), '2 reefs')
  assert.ok(!describePlan('genoa:2').includes('reef'), 'a furled headsail is not "reefed"')
  assert.strictEqual(describePlan('main:1'), '1 reef')
})

test('sails: validateSail guards the inventory', () => {
  const ok = { id: 'staysail', name: 'Staysail', station: 'head', reefs: 0 }
  assert.strictEqual(validateSail(ok).ok, true)
  assert.ok(DEFAULT_INVENTORY.every((s) => validateSail(s).ok), 'every shipped default is valid')
  const bad = (patch) => validateSail({ ...ok, ...patch })
  assert.strictEqual(bad({ id: 'stay+sail' }).ok, false)
  assert.strictEqual(bad({ id: 'Storm Jib' }).ok, false)
  assert.strictEqual(bad({ station: 'mizzen' }).ok, false)
  assert.strictEqual(bad({ name: '' }).ok, false)
  assert.strictEqual(bad({ reefs: 1.5 }).ok, false)
  assert.strictEqual(validateSail(null).ok, false)
  assert.ok(bad({ station: 'mizzen' }).error.length > 10, 'rejections carry a reason')
})

test('vendored: the sails copy names its upstream commit and hash', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sails', 'sails.js'), 'utf8')
  assert.match(src, /VENDORED from sailkick\/shared\/engine\/sails\.js/)
  assert.match(src, /@ [0-9a-f]{7,}\s+sha256:[0-9a-f]{16}/)
  assert.match(src, /Do not edit here/)
})

// ---------- 2. the write door ----------

function host () {
  const sent = []
  const logs = []
  const app = {
    debug: (m) => logs.push(m),
    error: (m) => logs.push(m),
    handleMessage: (_id, delta) => sent.push(...delta.updates[0].values)
  }
  return { s: createSails(app, { pluginId: 'sailkick-boat' }), sent, logs }
}

test('write door: a canonical plan is published as a SignalK delta', () => {
  const h = host()
  const r = h.s.setPlan({ plan: 'genoa:0+main:2' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.plan, 'genoa:0+main:2')
  assert.deepStrictEqual(h.sent, [{ path: 'sails.plan', value: 'genoa:0+main:2' }],
    'one delta on sails.plan, the string verbatim — the spool carries it from there')
  assert.ok(h.logs.some((m) => /2 reefs/.test(m)), 'and says it in words, for "when did we reef?"')
})

test('write door: a mis-sorted plan is REFUSED, not silently re-sorted', () => {
  // The failure this exists to prevent: "main:2+genoa:0" describes the right sails and
  // hashes differently from the canonical form, so accepting it would split the polar
  // cloud by insertion order. Refusing is louder than fixing — a client that sends it is
  // using its own encoder, which is the actual bug.
  const h = host()
  const r = h.s.setPlan({ plan: 'main:2+genoa:0' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.status, 400)
  assert.strictEqual(r.code, 'bad-plan')
  assert.match(r.message, /sorted by id/)
  assert.strictEqual(h.sent.length, 0, 'nothing reached SignalK')
})

test('write door: bare poles is accepted; nothing at all is not', () => {
  const h = host()
  assert.strictEqual(h.s.setPlan({ plan: 'bare' }).ok, true, 'the crew CAN say nothing is up')
  assert.strictEqual(h.sent[0].value, 'bare')

  for (const bad of [{}, { plan: '' }, { plan: '   ' }, { plan: null }, { plan: 42 }]) {
    const r = h.s.setPlan(bad)
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} refused`)
    assert.strictEqual(r.code, 'bad-plan')
  }
  assert.strictEqual(h.sent.length, 1, 'only the bare plan was published')
})

test('write door: garbage and delimiter-bearing ids never reach the bus', () => {
  const h = host()
  for (const plan of ['!!!', 'main', 'main:99', 'a+b:0', 'MAIN:0', 'main:1.5', 'genoa:0+genoa:0']) {
    const r = h.s.setPlan({ plan })
    assert.strictEqual(r.ok, false, `"${plan}" refused`)
  }
  assert.strictEqual(h.sent.length, 0)
})

test('write door: the status line reports what is set, in words', () => {
  const h = host()
  assert.match(h.s.status(), /none set yet/)
  h.s.setPlan({ plan: 'genoa:0+main:0' })
  assert.match(h.s.status(), /Genoa · Mainsail/)
  h.s.setPlan({ plan: 'main:3+stormjib:0' })
  assert.match(h.s.status(), /2 changes/)
})

test('write door: available() is false when this host cannot publish', () => {
  // The capability the app's screen reads. A host that cannot emit a delta must not
  // claim it can, or the screen offers controls that silently do nothing.
  const mute = createSails({ debug () {}, error () {} }, {})
  assert.strictEqual(mute.available(), false)
  assert.strictEqual(mute.setPlan({ plan: 'main:0' }).code, 'no-signalk')
  assert.strictEqual(host().s.available(), true)
})
