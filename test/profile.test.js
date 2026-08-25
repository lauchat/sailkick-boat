'use strict'

// The boat-local /api/profile store. Routes, polars and settings used to be proxied to
// the cloud, where the router is requireBoat-gated: the GET cache path forwards no
// headers, and the browser on the boat's LAN origin holds no cloud cookie to forward, so
// every call returned 401 (504 offline). The route panel showed nothing and mobile
// route-weather silently fell back to dead reckoning.
//
// These tests assert the envelopes the app actually consumes, matching the cloud's
// server/routes/profile.js exactly — public/ui/route-panel.js must not be able to tell
// the difference.

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createProfile } = require('../lib/profile')
const { createProxy } = require('../lib/proxy')

const app = { debug () {}, error () {} }
let seq = 0
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), `sk-prof-${process.pid}-${seq++}-`))

// Drive the module over real HTTP so the routing, bodies and status codes are all real.
function serve (profile) {
  const srv = http.createServer((req, res) => {
    if (profile.handles(req.url)) return profile.handle(req, res)
    res.statusCode = 418
    res.end('not ours')
  })
  return new Promise((r) => srv.listen(0, () => r(srv)))
}
const close = (srv) => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r) })

async function call (srv, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text }
}

test('profile: a route survives create -> list -> update -> delete, with the cloud envelopes', async () => {
  const dir = tmpDir()
  const profile = createProfile(app, { dataDir: dir })
  const srv = await serve(profile)

  // empty to start — the app expects the key present, not undefined
  const empty = await call(srv, 'GET', '/api/profile/routes')
  assert.strictEqual(empty.status, 200)
  assert.deepStrictEqual(empty.json, { ok: true, routes: [] })

  const made = await call(srv, 'POST', '/api/profile/routes', { name: 'Calvi', waypoints: [{ lat: 43, lon: 5 }] })
  assert.strictEqual(made.status, 201, 'created')
  assert.strictEqual(made.json.ok, true)
  assert.ok(made.json.item.id, 'server assigns the id')
  assert.ok(made.json.item.updatedAt, 'and a timestamp')
  assert.strictEqual(made.json.item.name, 'Calvi')
  const id = made.json.item.id

  const listed = await call(srv, 'GET', '/api/profile/routes')
  assert.strictEqual(listed.json.routes.length, 1)
  assert.strictEqual(listed.json.routes[0].id, id)

  const one = await call(srv, 'GET', `/api/profile/routes/${id}`)
  assert.strictEqual(one.status, 200)
  assert.strictEqual(one.json.item.name, 'Calvi')

  const upd = await call(srv, 'PUT', `/api/profile/routes/${id}`, { name: 'Calvi via Girolata', waypoints: [] })
  assert.strictEqual(upd.status, 200)
  assert.strictEqual(upd.json.item.name, 'Calvi via Girolata')
  assert.strictEqual(upd.json.item.id, id, 'the id is preserved, not regenerated')

  const del = await call(srv, 'DELETE', `/api/profile/routes/${id}`)
  assert.strictEqual(del.status, 200)
  assert.deepStrictEqual(del.json, { ok: true })
  assert.deepStrictEqual((await call(srv, 'GET', '/api/profile/routes')).json.routes, [])

  await close(srv)
})

test('profile: persists to disk atomically and reloads in a fresh instance', async () => {
  const dir = tmpDir()
  const p1 = createProfile(app, { dataDir: dir })
  const s1 = await serve(p1)
  const made = await call(s1, 'POST', '/api/profile/routes', { name: 'Bonifacio' })
  await close(s1)

  const file = path.join(dir, 'profile.json')
  assert.ok(fs.existsSync(file), 'written to the data dir')
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind')

  // A restart must find the route — this is the whole point of storing it locally.
  const p2 = createProfile(app, { dataDir: dir })
  const s2 = await serve(p2)
  const listed = await call(s2, 'GET', '/api/profile/routes')
  assert.strictEqual(listed.json.routes.length, 1)
  assert.strictEqual(listed.json.routes[0].id, made.json.item.id)
  await close(s2)
})

test('profile: settings, active polar and the whole-profile view', async () => {
  const dir = tmpDir()
  const profile = createProfile(app, { dataDir: dir })
  const srv = await serve(profile)

  assert.deepStrictEqual((await call(srv, 'GET', '/api/profile/settings')).json, { ok: true, settings: {} })
  assert.strictEqual((await call(srv, 'PUT', '/api/profile/settings', { units: 'metric' })).status, 200)
  assert.deepStrictEqual((await call(srv, 'GET', '/api/profile/settings')).json, { ok: true, settings: { units: 'metric' } })

  await call(srv, 'PUT', '/api/profile/active-polar', { id: 'abc123' })
  const whole = await call(srv, 'GET', '/api/profile')
  assert.strictEqual(whole.status, 200)
  assert.deepStrictEqual(whole.json.profile, { polars: [], activePolar: 'abc123', routes: [], alerts: [], settings: { units: 'metric' } })

  // ?section= returns just that slice
  assert.deepStrictEqual((await call(srv, 'GET', '/api/profile?section=settings')).json, { ok: true, profile: { units: 'metric' } })

  // clearing the pointer
  await call(srv, 'PUT', '/api/profile/active-polar', {})
  assert.strictEqual((await call(srv, 'GET', '/api/profile?section=activePolar')).json.profile, null)

  await close(srv)
})

test('profile: rejects bad bodies and unknown ids the way the cloud does', async () => {
  const dir = tmpDir()
  const profile = createProfile(app, { dataDir: dir })
  const srv = await serve(profile)

  for (const body of ['[]', '"nope"', 'not json', '']) {
    const r = await call(srv, 'POST', '/api/profile/routes', body)
    assert.strictEqual(r.status, 400, `body ${JSON.stringify(body)} -> 400`)
    assert.strictEqual(r.json.code, 'bad-body')
  }
  const missing = await call(srv, 'GET', '/api/profile/routes/nope')
  assert.strictEqual(missing.status, 404)
  assert.strictEqual(missing.json.code, 'not-found')

  const putMissing = await call(srv, 'PUT', '/api/profile/routes/nope', { name: 'x' })
  assert.strictEqual(putMissing.status, 404, 'PUT to a missing id is 404, not an upsert')
  assert.strictEqual(putMissing.json.code, 'not-found')
  assert.deepStrictEqual((await call(srv, 'GET', '/api/profile/routes')).json.routes, [], 'and nothing was written')

  // deleting something that isn't there is not an error (the cloud is idempotent here)
  assert.strictEqual((await call(srv, 'DELETE', '/api/profile/routes/nope')).status, 200)
  // an unknown section is not a section
  assert.strictEqual((await call(srv, 'GET', '/api/profile/wardrobe')).status, 404)

  await close(srv)
})

test('profile: concurrent saves are serialized — none is clobbered', async () => {
  // The read-modify-write is a whole-file rewrite, so without the queue a burst of
  // saves loses all but the last. The route panel can easily fire several.
  const dir = tmpDir()
  const profile = createProfile(app, { dataDir: dir })
  const srv = await serve(profile)

  const n = 12
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => call(srv, 'POST', '/api/profile/routes', { name: `leg-${i}` }))
  )
  assert.ok(results.every((r) => r.status === 201), 'all accepted')

  const listed = await call(srv, 'GET', '/api/profile/routes')
  assert.strictEqual(listed.json.routes.length, n, 'every concurrent save survived')
  assert.strictEqual(new Set(listed.json.routes.map((r) => r.id)).size, n, 'ids are unique')

  await close(srv)
})

test('profile: the mirror serves /api/profile locally instead of proxying it to the 401', async () => {
  // The regression that started this: upstream is the cloud, which would answer 401.
  let upstreamHits = 0
  const cloud = http.createServer((req, res) => {
    upstreamHits++
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":false,"code":"unauthorized"}')
  })
  await new Promise((r) => cloud.listen(0, r))

  // an ephemeral port the mirror can bind (proxyPort 0 means "don't listen")
  const probe = http.createServer()
  await new Promise((r) => probe.listen(0, r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))

  const dir = tmpDir()
  const profile = createProfile(app, { dataDir: dir })
  const proxy = createProxy(app, {
    sailkickUrl: `http://127.0.0.1:${cloud.address().port}`,
    proxyPort: port,
    storeDir: path.join(dir, 'store'),
    manifest: { enabled: false },
    seed: { enabled: false },
    profile
  })
  proxy.start()

  const mirror = `http://127.0.0.1:${port}`
  const listed = await fetch(`${mirror}/api/profile/routes`)
  assert.strictEqual(listed.status, 200, 'served locally, not the cloud 401')
  assert.deepStrictEqual(await listed.json(), { ok: true, routes: [] })

  const saved = await fetch(`${mirror}/api/profile/routes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'local' })
  })
  assert.strictEqual(saved.status, 201, 'saving works through the mirror too')
  assert.strictEqual(upstreamHits, 0, 'the cloud was never consulted')

  // and a path we do NOT own still goes upstream, so this dispatch is narrow
  await fetch(`${mirror}/api/something-else`).catch(() => {})
  assert.ok(upstreamHits > 0, 'unrelated /api paths still proxy to the cloud')

  proxy.stop()
  await new Promise((r) => { cloud.closeAllConnections && cloud.closeAllConnections(); cloud.close(r) })
})

// Alert rules live here, next to polars and routes — boat-local and deliberately NOT
// synced with the cloud copy, so a rule edited from ashore cannot change what the boat
// alarms on mid-passage. lib/alerts reads this file directly.
test('profile: alerts are a first-class section the alert engine can read back', async () => {
  const dir = tmpDir()
  const profile = createProfile(app, { dataDir: dir })
  const srv = await serve(profile)

  const empty = await call(srv, 'GET', '/api/profile/alerts')
  assert.deepStrictEqual(empty.json, { ok: true, alerts: [] }, 'the key is present, not undefined')

  const made = await call(srv, 'POST', '/api/profile/alerts',
    { kind: 'anchor-drift', name: 'Anchor', anchor: { lat: 43, lon: 6 }, radiusM: 50, forSec: 60 })
  assert.strictEqual(made.status, 201)
  const id = made.json.item.id
  assert.ok(id, 'gets an id like every other profile item')

  const upd = await call(srv, 'PUT', `/api/profile/alerts/${id}`, { kind: 'anchor-drift', radiusM: 80, enabled: false })
  assert.strictEqual(upd.status, 200)

  // What lib/alerts actually does: read the file, not the API.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'))
  assert.strictEqual(onDisk.alerts.length, 1)
  assert.strictEqual(onDisk.alerts[0].radiusM, 80)
  assert.strictEqual(onDisk.alerts[0].enabled, false)

  await call(srv, 'DELETE', `/api/profile/alerts/${id}`)
  assert.deepStrictEqual((await call(srv, 'GET', '/api/profile/alerts')).json.alerts, [])
  await close(srv)
})
