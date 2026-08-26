'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const { createProxy } = require('../lib/proxy')
const { createHistory } = require('../lib/history')

const app = { debug () {} }
let seq = 0
const tmp = () => path.join(os.tmpdir(), `skb-cfg-${process.pid}-${seq++}`)

// upstream serving the cloud /api/config (login on, history off, plus other fields)
function cloudConfig () {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      ok: true,
      auth: { required: true },
      boat: null,
      historyAvailable: false,
      models: ['gfs', 'ecmwf'],
      assets: { models: ['sailboat.glb'] }
    }))
  })
  return srv
}

async function callConfig (proxy) {
  return new Promise((resolve) => {
    const req = { url: '/api/config', method: 'GET', headers: {} }
    const res = { statusCode: 200, headers: {}, body: '', writableFinished: false, on () {}, setHeader (k, v) { this.headers[k] = v }, end (b) { this.body = b ? b.toString() : ''; this.writableFinished = true; resolve(this) } }
    proxy._serveConfig(req, res)
  })
}

test('serveConfig: disables login + forces historyAvailable when local history is on, preserves the rest', async () => {
  const up = cloudConfig(); await new Promise((r) => up.listen(0, r))
  const h = createHistory(app, { ringSource: { getState: () => ({ sogKt: 4, lat: 1, lon: 2 }) }, ringSampleSec: 99999, ringPersist: false }); h.start()
  assert.strictEqual(h.available(), true)
  const proxy = createProxy(app, { sailkickUrl: `http://127.0.0.1:${up.address().port}`, proxyPort: 0, history: h, storeDir: tmp(), manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()

  const res = await callConfig(proxy)
  const j = JSON.parse(res.body)
  assert.strictEqual(j.auth.required, false, 'login gate disabled')
  assert.strictEqual(j.historyAvailable, true, 'history forced on (served locally)')
  assert.deepStrictEqual(j.models, ['gfs', 'ecmwf'], 'other config preserved')
  assert.deepStrictEqual(j.assets, { models: ['sailboat.glb'] })
  assert.strictEqual(res.headers['Content-Type'], 'application/json')

  proxy.stop(); up.close()
})

test('serveConfig: without local history, historyAvailable is left as the cloud reports', async () => {
  const up = cloudConfig(); await new Promise((r) => up.listen(0, r))
  const hoff = createHistory(app, {}); hoff.start() // no telemetry source → not available
  const proxy = createProxy(app, { sailkickUrl: `http://127.0.0.1:${up.address().port}`, proxyPort: 0, history: hoff, storeDir: tmp(), manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()

  const res = await callConfig(proxy)
  const j = JSON.parse(res.body)
  assert.strictEqual(j.auth.required, false, 'login still disabled')
  assert.strictEqual(j.historyAvailable, false, 'not forced when history unavailable')

  proxy.stop(); up.close()
})

test('serveConfig: serves the cached copy when the cloud is offline (still login-disabled)', async () => {
  const up = cloudConfig(); await new Promise((r) => up.listen(0, r))
  const store = tmp()
  const proxy = createProxy(app, { sailkickUrl: `http://127.0.0.1:${up.address().port}`, proxyPort: 0, storeDir: store, manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()

  await callConfig(proxy)                 // warm the cache while "online"
  await new Promise((r) => up.close(r))   // go offline
  const res = await callConfig(proxy)     // must still serve, from cache, patched
  const j = JSON.parse(res.body)
  assert.strictEqual(j.auth.required, false)
  assert.deepStrictEqual(j.models, ['gfs', 'ecmwf'])

  proxy.stop()
})

// --- launcher endpoint (v0.20.0) ---------------------------------------------------
// Signal K serves public/index.html at /sailkick-boat/ for packages carrying the
// `signalk-webapp` keyword. That page runs outside this process, so it cannot know which
// port the mirror was configured on — it asks /plugins/sailkick-boat/info. One package
// can only produce one menu entry (webapps.js dedupes by package name), hence one
// launcher offering both the desktop and mobile surfaces.
test('launcher: /info reports the configured port, run state and pairing', async (t) => {
  let express
  try { express = require('express') } catch { return t.skip('express not installed') }
  const store = tmp()
  const factory = require('../index.js')
  const app = { getDataDirPath: () => store, debug () {}, setPluginStatus () {}, error () {} }
  const plugin = factory(app)

  const server = express(); const router = express.Router()
  plugin.registerWithRouter(router)
  server.use('/plugins/sailkick-boat', router)
  const h = server.listen(0); await new Promise((r) => h.once('listening', r))
  const base = `http://127.0.0.1:${h.address().port}/plugins/sailkick-boat/info`

  // before start: the plugin is off, so the page must say so rather than link nowhere
  const off = await (await fetch(base)).json()
  assert.strictEqual(off.running, false, 'not running before start')
  assert.strictEqual(off.paired, false)

  // a non-default port must be reported, or the launcher links to the wrong place
  plugin.start({ sync: { enabled: false }, proxy: { enabled: true, proxyPort: 9137, storeDir: store, manifest: { enabled: false }, seed: { enabled: false } } })
  const on = await (await fetch(base)).json()
  assert.strictEqual(on.running, true)
  assert.strictEqual(on.port, 9137, 'reports the CONFIGURED port, not the default')
  assert.strictEqual(on.paired, false, 'no account -> not paired, so the page warns sync is off')
  assert.ok(on.version, 'version is reported')

  // port 0 means "no standalone server" — the launcher renders a warning for it
  plugin.stop()
  plugin.start({ sync: { enabled: false }, proxy: { enabled: true, proxyPort: 0, storeDir: store, manifest: { enabled: false }, seed: { enabled: false } } })
  assert.strictEqual((await (await fetch(base)).json()).port, 0)

  plugin.stop()
  const after = await (await fetch(base)).json()
  assert.strictEqual(after.running, false, 'stop() clears it again')

  h.closeAllConnections && h.closeAllConnections()
  await new Promise((r) => h.close(r))
})

test('packaging: declares the webapp keyword, enable-by-default, and ships public/', () => {
  const pkg = require('../package.json')
  assert.ok(pkg.keywords.includes('signalk-webapp'), 'appears in the Signal K webapp menu')
  assert.ok(pkg.keywords.includes('signalk-node-server-plugin'), 'still a plugin')
  assert.strictEqual(pkg['signalk-plugin-enabled-by-default'], true)
  assert.ok(pkg.files.includes('public/'), 'the launcher page must be in the tarball')
  const fsp = require('node:fs'); const pth = require('node:path')
  const html = fsp.readFileSync(pth.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  assert.match(html, /\/plugins\/sailkick-boat\/info/, 'asks the plugin for its port')
  assert.match(html, /mobile\.html/, 'offers the mobile surface')

  // Webapp tile metadata: the admin UI reads signalk.appIcon + signalk.displayName, and
  // resolves the icon against the mount, which is public/ when that directory exists
  // (signalk-server interfaces/webapps.js mountWebModules). So an appIcon of './icon.png'
  // MUST be public/icon.png or the tile renders broken.
  assert.strictEqual(pkg.signalk && pkg.signalk.displayName, 'Sailkick')
  const iconRel = pkg.signalk && pkg.signalk.appIcon
  assert.ok(iconRel, 'declares an app icon')
  const icon = pth.join(__dirname, '..', 'public', pth.basename(iconRel))
  assert.ok(fsp.existsSync(icon), `${iconRel} must exist under public/ — that is what gets mounted`)
  const png = fsp.readFileSync(icon)
  assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'a real PNG')
  assert.strictEqual(png.readUInt32BE(16), 192, 'square 192px, as the admin UI expects')
  assert.strictEqual(png.readUInt32BE(20), 192)
  assert.ok(pkg.files.includes('public/'), 'the icon ships in the tarball')
  assert.ok(pkg.keywords.some((k) => k.startsWith('signalk-category-')), 'categorised in the app store')
  assert.match(html, /icon\.png/, 'the launcher shows it too')
})

// --- boat identity for the app (v0.21.3) --------------------------------------------
// The cloud fills config.boat only for a logged-in session, and the mirror forwards no
// cookie — so it always arrived null. Harmless for most of the UI, but
// public/engine/polar-cloud.js keys the performance data cloud on boat.perfKey and
// throws 'no boat identity' without it. On the boat the polar cloud was simply missing
// while its bake sat cached and reachable: /perf/<uuid>/estimate.json returned 200 with
// 2.5 MB. perfKey is DERIVED, not guessed — server/auth/registry.js defaults `bucket`
// and `perfKey` from the same identity, so bucket minus _raw is the key.
const UUID = '1fcad258-c422-4e93-a6f9-6811938499f6'

test('serveConfig: fills in boat identity so the polar data cloud can load', async () => {
  const up = cloudConfig(); await new Promise((r) => up.listen(0, r))
  const proxy = createProxy(app, {
    sailkickUrl: `http://127.0.0.1:${up.address().port}`,
    proxyPort: 0,
    storeDir: tmp(),
    manifest: { enabled: false },
    seed: { enabled: false },
    boat: { perfKey: UUID, slug: 'addiction' }
  })
  proxy.start()
  const j = JSON.parse((await callConfig(proxy)).body)
  assert.ok(j.boat, 'boat is no longer null')
  assert.strictEqual(j.boat.perfKey, UUID, 'the key the polar cloud fetches /perf/<key>/ with')
  assert.strictEqual(j.boat.slug, 'addiction')
  assert.strictEqual(j.boat.readOnly, false, 'the owner is never a read-only visitor')
  assert.strictEqual(j.auth.required, false, 'and the login gate is still disabled')
  proxy.stop(); up.close()
})

test('serveConfig: an unpaired boat leaves config.boat exactly as the cloud sent it', async () => {
  // No account -> no bucket -> no perfKey. Inventing one would point the app at a
  // /perf directory that does not exist, which is worse than no cloud at all.
  const up = cloudConfig(); await new Promise((r) => up.listen(0, r))
  const proxy = createProxy(app, {
    sailkickUrl: `http://127.0.0.1:${up.address().port}`,
    proxyPort: 0, storeDir: tmp(), manifest: { enabled: false }, seed: { enabled: false }
  })
  proxy.start()
  const j = JSON.parse((await callConfig(proxy)).body)
  assert.strictEqual(j.boat, null, 'untouched')
  assert.strictEqual(j.auth.required, false, 'the rest of the rewrite still applies')
  proxy.stop(); up.close()
})

test('perfKey is the bucket minus its _raw suffix, for UUID and legacy slug alike', () => {
  // The derivation the plugin entry performs. Pinning it here because it is the whole
  // reason no new config field was needed.
  const derive = (bucket) => (bucket ? String(bucket).replace(/_raw$/, '') : null)
  assert.strictEqual(derive(`${UUID}_raw`), UUID, 'UUID account')
  assert.strictEqual(derive('addiction_raw'), 'addiction', 'grandfathered slug account')
  assert.strictEqual(derive(''), null, 'unpaired')
  assert.strictEqual(derive('weird_raw_raw'), 'weird_raw', 'only the trailing suffix goes')
})

// The app's Alerts pane shows an amber "these rules are not being evaluated" banner unless
// a host claims them — rules stored with nothing watching them is exactly what it warns
// about. When lib/alerts is running, this plugin IS that host.
test('serveConfig: claims alertsEvaluatedHere when the alert engine is running here', async () => {
  const { createAlerts } = require('../lib/alerts')
  const up = cloudConfig(); await new Promise((r) => up.listen(0, r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skb-cfg-alerts-'))
  const profileFile = path.join(dir, 'profile.json')
  fs.writeFileSync(profileFile, JSON.stringify({ alerts: [] }))
  const alerts = createAlerts(app, { source: { getState: () => ({ lat: 1, lon: 2 }) }, profileFile })
  alerts.start()
  const proxy = createProxy(app, { sailkickUrl: `http://127.0.0.1:${up.address().port}`, proxyPort: 0, alerts, storeDir: tmp(), manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()
  const proxy2 = createProxy(app, { sailkickUrl: `http://127.0.0.1:${up.address().port}`, proxyPort: 0, storeDir: tmp(), manifest: { enabled: false }, seed: { enabled: false } })
  proxy2.start()
  // finally, not fall-through: a failed assertion used to skip the teardown and leave the
  // servers listening, which hangs the whole run instead of failing one test. That is the
  // same trap that made test/history.test.js hang the suite.
  try {
    assert.strictEqual(alerts.available(), true)
    assert.strictEqual(JSON.parse((await callConfig(proxy)).body).alertsEvaluatedHere, true)
    // …and no claim when the engine is off, or the pane would hide a real warning.
    assert.strictEqual(JSON.parse((await callConfig(proxy2)).body).alertsEvaluatedHere, undefined,
      'no engine ⇒ no claim, so the app keeps warning')
  } finally {
    proxy.stop(); proxy2.stop(); alerts.stop(); up.close()
  }
})

test('proxy: POST /api/alerts/anchor drops the anchor at the boat\'s own fix', async () => {
  const { createAlerts } = require('../lib/alerts')
  const { createProfile } = require('../lib/profile')
  const up = cloudConfig(); await new Promise((r) => up.listen(0, r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skb-anchor-'))
  fs.writeFileSync(path.join(dir, 'profile.json'),
    JSON.stringify({ alerts: [{ id: 'a1', kind: 'anchor-drift', radiusM: 50, forSec: 0 }] }))
  const profile = createProfile(app, { dataDir: dir })
  const alerts = createAlerts({ ...app, error () {}, handleMessage () {} }, {
    source: { getState: () => ({ lat: 43.5, lon: 6.5, updatedAt: new Date().toISOString() }) },
    profile,
    profileFile: path.join(dir, 'profile.json')
  })
  alerts.start()
  const proxy = createProxy(app, { sailkickUrl: `http://127.0.0.1:${up.address().port}`, proxyPort: 0, alerts, storeDir: tmp(), manifest: { enabled: false }, seed: { enabled: false } })
  proxy.start()

  const post = (body) => new Promise((resolve) => {
    const req = { url: '/api/alerts/anchor', method: 'POST', headers: {}, body }
    const res = { statusCode: 200, headers: {}, on () {}, setHeader (k, v) { this.headers[k] = v }, writableFinished: false, end (b) { this.body = b || ''; this.writableFinished = true; resolve(this) } }
    proxy._serveMirror(req, res)
  })
  try {
    const ok = await post({ ruleId: 'a1' })
    assert.strictEqual(ok.statusCode, 200)
    assert.deepStrictEqual(JSON.parse(ok.body).anchor, { lat: 43.5, lon: 6.5 })
    const bad = await post({ ruleId: 'nope' })
    assert.strictEqual(bad.statusCode, 404, 'an unknown rule is refused, not silently accepted')
    assert.strictEqual(JSON.parse(bad.body).ok, false)
  } finally { proxy.stop(); alerts.stop(); up.close() }
})
