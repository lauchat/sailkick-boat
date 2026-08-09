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
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8')
  assert.match(html, /\/plugins\/sailkick-boat\/info/, 'asks the plugin for its port')
  assert.match(html, /mobile\.html/, 'offers the mobile surface')
})
