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
